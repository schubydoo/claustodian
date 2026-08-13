#!/usr/bin/env node
// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Changelog scraper for Claustodian.
 *
 * Reads `CHANGELOG.md` from anthropics/claude-code (either fetched from the
 * raw GitHub URL, or a local file passed via `--changelog`), extracts CLI
 * flags / commands / env vars mentioned in backticks, and builds a
 * cumulative per-version symbol snapshot: once a symbol is first observed in
 * some version, it carries forward into every later version's snapshot
 * (changelog entries only ever *introduce* symbols; they never remove them
 * from our knowledge, since we have no reliable "this was removed" signal
 * from prose alone).
 *
 * The docs lane is always read from the committed `data/docs.json` (produced by
 * `npm run fetch-docs` from the official docs pages) — it is not CLI-overridable,
 * so generated data can't attribute arbitrary local content to the docs lane.
 *
 * Usage:
 *   tsx scripts/scrape-changelog.ts [--changelog <path>] [--out <dir>] [--all]
 *
 *   --changelog <path>  Read the changelog from a local file instead of fetching
 *                       the official CHANGELOG.md. For in-process CLI tests only:
 *                       refused when --out is the committed "data" directory, so
 *                       the shipped dataset is always from the official fetch.
 *   --out <dir>         Output directory (default: "data")
 *   --all               Write every version's snapshot under <dir>/versions/,
 *                       plus <dir>/index.json and <dir>/latest.json. Without
 *                       this flag, only <dir>/index.json and <dir>/latest.json
 *                       are written (the full per-version backfill is opt-in).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  assertBinaryDescriptions,
  assertBinaryObservations,
  binaryConfigCategory,
  binaryEnvCategory,
  type BinaryDescriptions,
  type BinaryObservations,
  descriptionAt,
  isCurrentDescriptionEra,
  isPublishableBinaryEnv,
  binaryFlagCategory,
  type HiddenEra,
  isPublishableBinaryFlag,
  mayRedateFromBinary,
  loadBinaryDescriptions,
  loadBinaryObservations,
  promotionFor,
} from './binary-lane.js';
import { assertOfficialDocs, DOCS_BASE, type DocsIndex } from './fetch-docs.js';
import { applyChangelogDeprecations, applyChangelogRemovals } from './removals.js';
import { compareVersionsAsc, type ExtractedSymbolType, isMain, loadChangelog } from './lib.js';
import { scopesFor } from './symbol-scopes.js';

// Re-exported from lib for existing importers (tests, extract-bundle, etc.).
export { compareVersionsAsc, type ExtractedSymbolType };

const SOURCE_URL = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const SCHEMA_VERSION = '1.0.0';

/** One version's worth of raw changelog data, as parsed from the markdown. */
export interface ChangelogBlock {
  version: string;
  bullets: string[];
}

export interface ExtractedSymbol {
  symbol: string;
  type: ExtractedSymbolType;
}

/**
 * The shape this pipeline assembles. A SUBSET of schema/symbol.schema.json, not a
 * mirror of it: the schema's `type` enum also allows `control_message`, and those
 * records carry `family` and `direction`, none of which any lane here emits. Keep
 * this narrower than the contract rather than in step with it — widening it would
 * add fields nothing populates.
 */
export interface SymbolRecord {
  symbol: string;
  type: 'cli_flag' | 'env_var' | 'command' | 'config_key' | 'internal_config_flag';
  first_seen: string;
  first_seen_estimated?: boolean;
  removed_in: string | null;
  /**
   * Version whose changelog deprecated the symbol, if any. Metadata carried on
   * the record; the per-version `status` flip to `deprecated` at/after this
   * version happens in assembleSnapshots. Absent when the symbol is not deprecated.
   */
  deprecated_in?: string;
  status: 'active' | 'deprecated' | 'removed' | 'needs_review';
  provenance: 'changelog' | 'docs' | 'binary';
  confidence: 'high' | 'medium' | 'low';
  description: string;
  description_source?: 'docs' | 'changelog' | 'binary' | 'help';
  source_url: string | null;
  category: string;
  /**
   * Subcommands this flag is accepted under. Complete when present, so a
   * non-empty list also means the flag is NOT accepted on bare `claude`. Absent
   * means no scope information. See scripts/symbol-scopes.ts.
   */
  scopes?: readonly string[];
}

export interface VersionSnapshot {
  version: string;
  symbols: SymbolRecord[];
}

export interface SymbolIndex {
  schemaVersion: string;
  latest: string;
  versions: string[];
}

const VERSION_HEADING_RE = /^##\s+(\d+\.\d+\.\d+)\s*$/;

/**
 * Splits a changelog markdown document into per-version blocks, in the same
 * order the headings appear in the file (upstream is newest-first). Any
 * content before the first `## X.Y.Z` heading (title, intro prose, etc.) is
 * ignored. Bullet lines are lines beginning with `- ` (after trimming
 * surrounding whitespace); the `- ` prefix is preserved on each bullet.
 */
export function parseChangelog(md: string): ChangelogBlock[] {
  const lines = md.split(/\r?\n/);
  const blocks: ChangelogBlock[] = [];
  let current: ChangelogBlock | null = null;

  for (const rawLine of lines) {
    const headingMatch = VERSION_HEADING_RE.exec(rawLine);
    if (headingMatch) {
      const version = headingMatch[1];
      if (version === undefined) {
        continue;
      }
      current = { version, bullets: [] };
      blocks.push(current);
      continue;
    }

    if (!current) {
      // Preamble before the first version heading; ignore.
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed.startsWith('- ')) {
      current.bullets.push(trimmed);
    }
  }

  return blocks;
}

interface PositionedSymbol extends ExtractedSymbol {
  index: number;
}

const SYMBOL_PATTERNS: Array<[RegExp, ExtractedSymbolType]> = [
  [/`(--[a-z0-9][a-z0-9-]*)`/g, 'cli_flag'],
  [/`(\/[a-z][a-z0-9-]*)`/g, 'command'],
  [/`([A-Z][A-Z0-9_]{3,})`/g, 'env_var'],
];

/**
 * Tokens that match the broad env_var pattern but are NOT Claude Code symbols —
 * mostly Node/libuv error codes and generic acronyms that appear in changelog
 * prose in backticks. Curated denylist; extend as new false positives surface.
 * Real env vars (HOME, PATH, EDITOR, DISABLE_*, ...) are intentionally kept —
 * they are genuine, just categorized as third-party noise downstream.
 */
export const SYMBOL_DENYLIST: ReadonlySet<string> = new Set([
  // Node/libuv errno codes
  'EACCES',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'EAGAIN',
  'EBADF',
  'EBUSY',
  'ECANCELED',
  'ECHILD',
  'ECOMPROMISED',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EFAULT',
  'EFBIG',
  'EHOSTUNREACH',
  'EINTR',
  'EINVAL',
  'EISCONN',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'EMSGSIZE',
  'ENAMETOOLONG',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENFILE',
  'ENOBUFS',
  'ENODEV',
  'ENOENT',
  'ENOMEM',
  'ENOPROTOOPT',
  'ENOSPC',
  'ENOSYS',
  'ENOTCONN',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENOTFOUND',
  'ENOTSOCK',
  'ENOTSUP',
  'EOVERFLOW',
  'EPERM',
  'EPIPE',
  'EPROTO',
  'ERANGE',
  'EROFS',
  'ESHUTDOWN',
  'ESPIPE',
  'ESRCH',
  'ETIMEDOUT',
  'EXDEV',
  // formats / serialization / encodings
  'JSON',
  'HTML',
  'HTTP',
  'HTTPS',
  'YAML',
  'TOML',
  'ASCII',
  'UTF8',
  'MIME',
  'CRLF',
  'ANSI',
  'UUID',
  'SHA256',
  'SHASUMS',
  // literals / keywords
  'NULL',
  'TRUE',
  'FALSE',
  // git / doc terms
  'HEAD',
  'README',
  'TODO',
  'FIXME',
]);

/**
 * Tokens the CHANGELOG names incidentally in prose but which are a subprocess
 * tool's own primitives (git's, here) — not Claude Code's — so they must not be
 * seeded as symbols from changelog text. Seeded by the 2.1.216 bugfix bullet
 * "Fixed worktree-isolated subagents redirecting git into the shared checkout
 * via `git -C`, `--git-dir`, or `GIT_DIR`/`GIT_WORK_TREE`" (`git -C` is already
 * safe — the space excludes it from the token patterns).
 *
 * Deliberately scoped to the changelog lane, NOT folded into the shared
 * SYMBOL_DENYLIST: extract-bundle consults that denylist too, and a shipped
 * binary that genuinely reads `process.env.GIT_DIR`/`GIT_WORK_TREE` (plausible —
 * the fix above is precisely about Claude Code inspecting these) would be real
 * first-party evidence. Suppressing it there would silently drop the symbol from
 * binary evidence with no coverage failure to catch it.
 */
export const CHANGELOG_SYMBOL_DENYLIST: ReadonlySet<string> = new Set([
  '--git-dir',
  'GIT_DIR',
  'GIT_WORK_TREE',
]);

/**
 * Extracts backtick-delimited cli_flag / command / env_var tokens from a
 * single bullet's text. Returns unique {symbol, type} pairs ordered by where
 * they first appear in the text (left to right), regardless of which of the
 * three patterns matched them.
 */
export function extractSymbols(text: string): ExtractedSymbol[] {
  const found: PositionedSymbol[] = [];

  for (const [pattern, type] of SYMBOL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const symbol = match[1];
      if (symbol === undefined || match.index === undefined) {
        continue;
      }
      if (SYMBOL_DENYLIST.has(symbol) || CHANGELOG_SYMBOL_DENYLIST.has(symbol)) {
        continue;
      }
      found.push({ symbol, type, index: match.index });
    }
  }

  found.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const result: ExtractedSymbol[] = [];
  for (const { symbol, type } of found) {
    const key = `${type}:${symbol}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ symbol, type });
    }
  }
  return result;
}

function bulletDescription(bullet: string): string {
  return bullet.startsWith('- ') ? bullet.slice(2) : bullet;
}

function compareSymbolRecords(a: SymbolRecord, b: SymbolRecord): number {
  if (a.type !== b.type) {
    return a.type < b.type ? -1 : 1;
  }
  if (a.symbol !== b.symbol) {
    return a.symbol < b.symbol ? -1 : 1;
  }
  return 0;
}

/**
 * Best-effort ownership/source category, so consumers can filter Claude Code's
 * own surface from environment variables the bundle merely references. CLI
 * flags and commands are always Claude Code's own. Env vars are bucketed by
 * well-known third-party prefixes; anything unrecognized stays "other" (it may
 * still be a Claude Code var — categories are a filter aid, not a guarantee).
 */
const ENV_CATEGORY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(CLAUDE|ANTHROPIC)/, 'claude-code'],
  [
    /^(AWS|AZURE|GOOGLE|GCLOUD|GCP|GCE|CLOUD|CLOUDSDK|GAE|K_SERVICE|K_CONFIGURATION|FUNCTION_|VERCEL|NETLIFY|RAILWAY|FLY_|RENDER|DYNO|HEROKU|WEBSITE_|CODESPACE|GITPOD|DEVPOD|DAYTONA|CODER|REPL)/,
    'cloud',
  ],
  [
    /^(GITHUB|GITLAB|BUILDKITE|CIRCLE|JENKINS|TRAVIS|APPVEYOR|TEAMCITY|DRONE|BITBUCKET|RUNNER)|^CI$/,
    'ci',
  ],
  [/^(NODE|BUN|NPM|DENO|UV_|PNPM|YARN|COREPACK|GRPC)/, 'runtime'],
  [
    /^(TERM|ITERM|KITTY|ALACRITTY|KONSOLE|VTE|WEZTERM|COLORTERM|WT_|TMUX|ZELLIJ|TILIX|TERMINATOR|GNOME_TERMINAL|XTERM)/,
    'terminal',
  ],
  [/^OTEL/, 'telemetry'],
  [/_PROXY$|^NO_PROXY$|^ALL_PROXY$/, 'network'],
];

export function categorize(symbol: string, type: ExtractedSymbolType): string {
  if (type === 'cli_flag') return 'cli';
  if (type === 'command') return 'command';
  // Settings keys are their own surface; the env-var prefix rules below would
  // otherwise bucket them all as "other".
  if (type === 'config_key' || type === 'internal_config_flag') return 'settings';
  for (const [pattern, category] of ENV_CATEGORY_RULES) {
    if (pattern.test(symbol)) return category;
  }
  return 'other';
}

/** A bullet that *introduces* a symbol (vs. names it incidentally in a fix). */
const INTRODUCING_RE =
  /^\s*(add|added|adds|new|introduce|introduced|introduces|now support|added support|support for)\b/i;

export function isIntroducingBullet(bullet: string): boolean {
  return INTRODUCING_RE.test(bulletDescription(bullet));
}

/**
 * A bullet that documents support for a *subprocess tool's own* flags (git's,
 * docker's, etc.), listing them as examples — those flags belong to that tool,
 * not Claude Code, so they must not be extracted as `cli_flag` symbols. The tell
 * is a tool name + "flags" + a parenthesised example list, which the changelog
 * writes either with an "e.g.," lead-in or as a bare list opening straight off
 * the word "flags":
 *
 *  - 2.1.30 — "Added support for additional `git log` and `git show` flags in
 *    read-only mode (e.g., `--topo-order`, `--cherry-pick`, `--format`, `--raw`)"
 *  - 2.1.214 — "Added permission prompts for `docker` commands … carrying
 *    daemon-redirect flags (`--url`, `--connection`, `--identity`, …)"
 *  - 2.1.229 — "Changed `/commit-push-pr` so git/gh commands with dangerous
 *    flags (`--force`, `--amend`, `--no-verify`, etc.) are no longer
 *    auto-approved"
 *
 * Every flag those three clauses list belongs to git, gh or docker; the binary
 * lane never observes any of them as a Claude Code flag. Still deliberately
 * narrow — the clause has to open off the word "flags" (or carry "e.g.,") AND
 * contain at least one flag token — so it cannot suppress a genuine "Added a
 * `--foo` flag for git integration"-style bullet, nor fire on a bullet whose
 * only parenthetical is an issue link.
 */
const SUBPROCESS_FLAG_BULLET =
  /\b(?:git|gh|npm|node|docker|ripgrep|rg)\b[^.]*\bflags?\b(?:[^.]*\(e\.g\.,|\s*\()/i;

/**
 * The parenthesised example clause of a subprocess-flag bullet, bounded to its
 * closing ")" so only the example flags are captured — a real first-party flag
 * before OR after the parenthetical is left for normal extraction. Null when the
 * bullet has no such clause.
 */
function subprocessExampleClause(bullet: string): string | null {
  const match = SUBPROCESS_FLAG_BULLET.exec(bullet);
  if (match === null) {
    return null;
  }
  // The match ends at the clause opener — either "(e.g.," or a bare "(" — so the
  // last "(" inside the match is that opener.
  const open = bullet.lastIndexOf('(', match.index + match[0].length - 1);
  if (open === -1) {
    return null;
  }
  const close = bullet.indexOf(')', open);
  return bullet.slice(open, close === -1 ? undefined : close + 1);
}

export function isSubprocessFlagBullet(bullet: string): boolean {
  return subprocessFlagExamples(bullet).size > 0;
}

/**
 * The `--flag` tokens a subprocess-flag bullet lists inside its example clause —
 * the subprocess tool's own flags, which must not be extracted as Claude Code
 * `cli_flag` symbols. Empty set for any bullet that isn't a subprocess-flag
 * bullet.
 */
export function subprocessFlagExamples(bullet: string): ReadonlySet<string> {
  const flags = new Set<string>();
  const clause = subprocessExampleClause(bullet);
  if (clause === null) {
    return flags;
  }
  for (const { symbol, type } of extractSymbols(clause)) {
    if (type === 'cli_flag') {
      flags.add(symbol);
    }
  }
  return flags;
}

/**
 * Flag tokens the changelog sometimes writes as prose rather than as a real
 * flag, and which no released binary defines. Each maps to a regex matching
 * ONLY that phantom usage, so the token is kept by default and dropped only on
 * a match — we would rather keep a real flag than mask one.
 *
 * `--compact`: the changelog writes it for the `/compact` command / compaction
 * *event* ("… not resuming … after `--compact`") — always as the object of a
 * preposition, never introduced as a flag. The real symbol is the `/compact`
 * command (confirmed absent from every released binary via the binary lane).
 * The regex matches the token only when a preposition immediately precedes it,
 * so a genuine introduction ("Added `--compact`", "Expose `--compact` as a
 * flag", "`--compact`: new flag") is left untouched and keeps its first_seen.
 */
const PHANTOM_FLAG_PROSE_USAGE: ReadonlyMap<string, RegExp> = new Map([
  ['--compact', /\b(?:after|before|during|following|upon|from|on|via)\s+`--compact`/i],
]);

interface CollectedSymbol {
  record: SymbolRecord;
  introducing: boolean;
}

/**
 * Collects every changelog symbol, oldest -> newest, registering it on first
 * appearance with `first_seen` = that version and `description` = the bullet
 * text. Also flags whether that first bullet *introduces* the symbol (vs. names
 * it incidentally), which enrichment uses to judge first_seen confidence. First
 * registration wins; re-mentions never change a symbol.
 */
export function collectChangelogSymbols(blocks: ChangelogBlock[]): Map<string, CollectedSymbol> {
  const oldestFirst = [...blocks].reverse();
  const known = new Map<string, CollectedSymbol>();

  for (const block of oldestFirst) {
    for (const bullet of block.bullets) {
      const subprocessExampleFlags = subprocessFlagExamples(bullet);
      const introducing = isIntroducingBullet(bullet);
      for (const { symbol, type } of extractSymbols(bullet)) {
        if (type === 'cli_flag') {
          // A subprocess tool's own flags, listed in this bullet's "(e.g., …)"
          // example clause, are not Claude Code's — skip just those (a real
          // first-party flag elsewhere in the bullet still counts).
          if (subprocessExampleFlags.has(symbol)) {
            continue;
          }
          // Phantom flag the changelog writes as prose (e.g. `--compact` for the
          // /compact command) — drop it only in that incidental usage, never
          // when the bullet actually introduces it (see PHANTOM_FLAG_PROSE_USAGE).
          const phantomUsage = PHANTOM_FLAG_PROSE_USAGE.get(symbol);
          if (phantomUsage !== undefined && phantomUsage.test(bullet)) {
            continue;
          }
        }
        const key = `${type}:${symbol}`;
        if (known.has(key)) {
          continue;
        }
        known.set(key, {
          introducing,
          record: {
            symbol,
            type,
            first_seen: block.version,
            removed_in: null,
            status: 'active',
            provenance: 'changelog',
            confidence: 'high',
            description: bulletDescription(bullet),
            source_url: SOURCE_URL,
            category: categorize(symbol, type),
          },
        });
      }
    }
  }

  return known;
}

/**
 * Assembles cumulative per-version snapshots from a finalized symbol list: each
 * version's snapshot holds every symbol live at that version — `first_seen` <=
 * version AND (no `removed_in`, or version is before it) — sorted deterministically
 * by type then symbol name.
 *
 * `status` is resolved per version: a symbol carrying `deprecated_in` reads
 * `active` in snapshots before that version and `deprecated` at/after it (while
 * still present — deprecation, unlike removal, does not drop the symbol). Removal
 * is expressed by absence (`removed_in` filters the symbol out), so `status` never
 * needs to say "removed". `removed_in`/`deprecated_in` are set by the binary lane
 * and the curated changelog lifecycle lane ([[removals.ts]]).
 *
 * `description` is resolved per version too when a binary description timeline is
 * supplied: the current era keeps the record's curated (docs/changelog) description
 * when it has one; a HISTORICAL snapshot gets the description the symbol actually
 * had at that version (from the archived binaries); and a symbol with no curated
 * description at all is filled from the binary at every version. All binary-sourced
 * descriptions are stamped `description_source: "binary"`.
 *
 * `scopes` is resolved per version as well: a binary-proved scope applies only
 * from the version whose binary evidenced it, so a historical snapshot never
 * claims a subcommand that did not exist yet.
 */
/** A binary-proved scope set and the earliest version that evidenced it. */
export interface BinaryScopeWindow {
  from: string;
  scopes: readonly string[];
}

/**
 * A description that names state the snapshot cannot have yet.
 *
 * `docs.json` is ONE capture of the current documentation — there is no
 * per-version docs history — so a docs-sourced description is evidence about the
 * tip and nothing else. Publishing it unchanged into every historical snapshot
 * backfills today's answer into the past, which is the thing invariant 4 exists
 * to forbid, and it produces text that refutes itself: `data/versions/2.1.200.json`
 * described `/review` with "Before v2.1.223, `/review` was a separate command".
 *
 * The check is self-consistency against the dataset rather than a heuristic about
 * prose. A description is anachronistic at `version` when it names either
 *   - a release later than `version` (`v2.1.223`, `2.1.223`), or
 *   - a backticked symbol of any of the four surfaces whose OWN `first_seen` is
 *     later than `version` — `/code-review` at 2.1.150 named `--post`, dated
 *     2.1.227, and `DISABLE_TELEMETRY` at 0.2.100 named `DISABLE_GROWTHBOOK`,
 *     dated 2.1.124. The span must hold the symbol ALONE: a symbol inside a
 *     multi-word span such as `` `claude --cloud` `` is not matched. That gap
 *     under-corrects, since the guard only ever removes text.
 *
 * Neither half guesses. A dotted triple counts only when it is a release this
 * dataset actually has, and a symbol counts only when its date is evidence:
 *
 *   - `terminalProgressBarEnabled` is documented as "Ghostty 1.2.0+, and iTerm2
 *     3.6.6+". Those are other products' versions. Compared as releases, `3.6.6`
 *     beats every Claude Code version ever shipped, so a bare-triple rule reads
 *     correct current prose as anachronistic AT THE TIP, rewriting that record
 *     everywhere including `latest.json`. An IPv4 literal (`127.0.0.1` yields
 *     `127.0.0`) and a four-part build number do the same. Requiring a known
 *     release rejects all three, because none of them is one.
 *   - A `first_seen_estimated` date is an UPPER BOUND, not evidence — the schema
 *     says so. `--help` is stamped 2.1.200 and has existed since the earliest
 *     archived release. Treating that as proof of absence is the same guess this
 *     function refuses to make for a symbol it has never heard of, so an
 *     estimated record is excluded from the map by its builder.
 */
const VERSION_IN_PROSE = /\bv?(\d+\.\d+\.\d+)\b/g;
const TOKEN_IN_PROSE = /`([^`\s]+)`/g;

/**
 * The record keys a backticked token could name, by its own spelling.
 *
 * All four surfaces appear in these descriptions, not just flags and commands:
 * `DISABLE_TELEMETRY`'s docs text names `` `DISABLE_GROWTHBOOK` `` (2.1.124) and
 * publishes it at 0.2.100. Matching only `--flag` and `/command` left every env-var
 * and settings-key reference unchecked.
 *
 * A BARE lowercase word is deliberately excluded. `ultracode` and `env` are real
 * settings keys and also ordinary words a description can backtick meaning
 * something else, and a false positive here truncates correct text. camelCase and
 * dotted keys carry their own evidence of being an identifier, so the rule stays
 * on tokens that cannot be mistaken for prose.
 */
function recordKeysFor(token: string): string[] {
  if (/^--[a-z][a-z0-9-]*$/.test(token)) return [`cli_flag:${token}`];
  if (/^\/[a-z][a-z0-9-]*$/.test(token)) return [`command:${token}`];
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(token)) return [`env_var:${token}`];
  if (/[a-z][A-Z]/.test(token) || token.includes('.')) return [`config_key:${token}`];
  return [];
}

export function describesFutureState(
  text: string,
  version: string,
  firstSeenByKey: ReadonlyMap<string, string>,
  releases: ReadonlySet<string>
): boolean {
  for (const match of text.matchAll(VERSION_IN_PROSE)) {
    const named = match[1] as string;
    if (!releases.has(named)) continue;
    if (compareVersionsAsc(named, version) > 0) return true;
  }
  for (const match of text.matchAll(TOKEN_IN_PROSE)) {
    for (const key of recordKeysFor(match[1] as string)) {
      const firstSeen = firstSeenByKey.get(key);
      if (firstSeen !== undefined && compareVersionsAsc(firstSeen, version) > 0) return true;
    }
  }
  return false;
}

/**
 * Split on sentence ends that are NOT inside a code span. A description carries
 * spans like `` `2.1.0` `` and `` `--flag` ``, and splitting inside one would cut
 * a token in half and defeat the check that runs on each sentence.
 */
const ABBREVIATION_END = /\b(?:e\.g|i\.e|etc|vs|approx|cf|no)\.$/i;

function sentencesOutsideCode(text: string): string[] {
  const out: string[] = [];
  let buffer = '';
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '`') inCode = !inCode;
    buffer += char;
    const ends = char === '.' || char === '!' || char === '?';
    // `e.g.` and `etc.` end a word, not a sentence. Splitting there would cut a
    // clause off mid-thought and drop the half that carries the qualifier.
    if (!inCode && ends && !ABBREVIATION_END.test(buffer)) {
      if (i + 1 >= text.length || /\s/.test(text[i + 1] as string)) {
        out.push(buffer);
        buffer = '';
      }
    }
  }
  if (buffer.trim() !== '') out.push(buffer);
  return out;
}

/**
 * Keep the leading sentences that name nothing later than `version`, and drop the
 * rest. "Nothing later" is the whole of the check — a sentence can still be wrong
 * for its version in a way no rule here can see.
 *
 * These descriptions are an era-correct opening followed by sentences appended as
 * behaviour grew — "Override the API endpoint … As of v2.1.196, …". Discarding the
 * whole string would throw away correct text, so truncation keeps what the version
 * can carry. A record empties only when its FIRST sentence already names the
 * future, and only when the binary lane has no description to fall back on —
 * `MCP_OAUTH_CALLBACK_PORT` before 2.1.30 is the shape. Empty is the honest answer
 * there: no leading sentence avoids naming the future.
 */
export function truncateToVersion(
  text: string,
  version: string,
  firstSeenByKey: ReadonlyMap<string, string>,
  releases: ReadonlySet<string>
): string {
  const kept: string[] = [];
  for (const sentence of sentencesOutsideCode(text)) {
    if (describesFutureState(sentence, version, firstSeenByKey, releases)) break;
    kept.push(sentence);
  }
  return kept.join('').trim();
}

export function assembleSnapshots(
  records: SymbolRecord[],
  blocks: ChangelogBlock[],
  binaryDescriptions?: BinaryDescriptions['descriptions'],
  binaryScopes?: ReadonlyMap<string, BinaryScopeWindow>,
  binaryHidden?: ReadonlyMap<string, readonly HiddenEra[]>,
  observedVersions?: readonly string[]
): VersionSnapshot[] {
  const versionsOldestFirst = blocks
    .map((block) => block.version)
    .sort((a, b) => compareVersionsAsc(a, b));

  const liveAt = (record: SymbolRecord, version: string): boolean =>
    compareVersionsAsc(record.first_seen, version) <= 0 &&
    (record.removed_in === null || compareVersionsAsc(version, record.removed_in) < 0);

  // Flip an active symbol to `deprecated` in versions at/after its deprecation
  // (a new object per snapshot, so earlier snapshots keep `active`).
  const statusAt = (record: SymbolRecord, version: string): SymbolRecord =>
    record.deprecated_in !== undefined &&
    record.status === 'active' &&
    compareVersionsAsc(version, record.deprecated_in) >= 0
      ? { ...record, status: 'deprecated' }
      : record;

  /**
   * Attaches curated scopes. Applied here rather than in finalizeRecord because
   * every published record passes through this map regardless of which lane
   * constructed it, and scope is a property of the symbol rather than of the lane
   * that happened to find it.
   */
  const withScopes = (record: SymbolRecord, version: string): SymbolRecord => {
    // A binary scope is evidence from a specific version ONWARD, and applying it
    // to earlier snapshots would claim an invocation that did not exist yet:
    // `--capacity` is remote-control's alone at 2.1.100, because
    // `claude self-hosted-runner` does not ship until 2.1.224. The curated table
    // carries no version and still applies to every snapshot — that point-in-time
    // trade is documented in symbol-scopes.ts — but the binary lane KNOWS when it
    // saw the parser, so discarding that would be throwing away evidence we have.
    const observed = binaryScopes?.get(`${record.type}:${record.symbol}`);
    const proved =
      observed && compareVersionsAsc(version, observed.from) >= 0 ? observed.scopes : undefined;
    const scopes = scopesFor(record.type, record.symbol, proved);
    return scopes ? { ...record, scopes } : record;
  };

  /** Same record unless the category actually differs — keeps snapshots stable. */
  const withCategory = (record: SymbolRecord, category: string): SymbolRecord =>
    record.category === category ? record : { ...record, category };

  /**
   * Resolves a flag's `cli` / `cli-internal` category for THIS version.
   *
   * Deliberately not folded into describeAt: that function returns early for
   * symbols with no description timeline, and visibility is independent of
   * whether a flag was ever described. Six flags flip between hidden and public
   * across the archive, so a single record-level value would report today's
   * visibility for every historical snapshot.
   */
  const withFlagVisibility = (record: SymbolRecord, version: string): SymbolRecord => {
    if (record.type !== 'cli_flag') return record;
    const eras = binaryHidden?.get(`${record.type}:${record.symbol}`);
    if (!eras) return record;
    // Resolve against the NAME-BASED category, never record.category. The record
    // was created with the last_seen value, so feeding it back in makes "not
    // hidden at this version" return the tip's answer — a flag that only became
    // hidden later would read cli-internal for its whole public life.
    return withCategory(
      record,
      binaryFlagCategory(eras, version, categorize(record.symbol, record.type))
    );
  };

  /**
   * Every release this dataset has evidence of, so a dotted triple in prose can be
   * told apart from another product's version number.
   *
   * The union of both lanes, not the changelog alone. Anthropic ships releases with
   * no changelog heading — more versions have an extracted binary than have a
   * snapshot — and the docs cite them. Gating on snapshots alone left `2.1.182`
   * and `2.1.213` unrecognised, so `data/versions/2.1.181.json` went on publishing
   * "From v2.1.182, named shorthand keys are also accepted": a 2.1.181 snapshot
   * describing 2.1.182, which is the very defect this guard exists to remove.
   */
  const releases = new Set([...versionsOldestFirst, ...(observedVersions ?? [])]);

  /**
   * Every symbol's own `first_seen`, so a description can be tested against it.
   * An ESTIMATED date is excluded: it is an upper bound the schema itself labels
   * unconfirmed, so treating it as proof the symbol did not exist yet is the same
   * guess `describesFutureState` refuses to make for an unknown symbol. `/undo`
   * (2.1.108) carries the flag, and `/rewind`'s description names `/undo`, so
   * trusting it rewrites `/rewind` across its whole history on a guess.
   */
  const firstSeenByKey = new Map(
    records
      .filter((r) => r.first_seen_estimated !== true)
      .map((r) => [`${r.type}:${r.symbol}`, r.first_seen])
  );

  /**
   * Last resort when no era-correct binary text exists: keep the leading sentences
   * that name nothing later than the version. A description that already names
   * nothing later is returned untouched, so the common case allocates nothing.
   */
  const deanachronize = (record: SymbolRecord, version: string): SymbolRecord => {
    const text = record.description;
    if (text === '' || !describesFutureState(text, version, firstSeenByKey, releases))
      return record;
    const truncated = truncateToVersion(text, version, firstSeenByKey, releases);
    // `description_source` names where the text came from, and the schema says it
    // is absent when the description is empty. Keeping it on an emptied record
    // would assert "the official docs say this" while saying nothing.
    if (truncated === '') {
      const emptied: SymbolRecord = { ...record, description: '' };
      delete emptied.description_source;
      return emptied;
    }
    return { ...record, description: truncated };
  };

  // Resolve the description from the binary timeline: a curated (non-empty)
  // description wins in the current era; a HISTORICAL snapshot takes the text
  // observed in that version's binary (de-anachronized), and a previously-EMPTY
  // description is filled from the binary at every version. Symbols with no
  // timeline, or versions before the first binary observation, are untouched.
  const describeAt = (record: SymbolRecord, version: string): SymbolRecord => {
    const eras = binaryDescriptions?.[`${record.type}:${record.symbol}`];
    // Runs even with no binary timeline: the anachronism guard below is the only
    // thing standing between a docs-sourced description and every snapshot the
    // symbol is live at, and a record with no binary timeline has nothing else to
    // fall back on — `MCP_OAUTH_CALLBACK_PORT` is that shape.
    if (!eras || eras.length === 0) return deanachronize(record, version);
    // A config key's category is per-version for the same reason its description
    // is: the `@internal` marker lives IN the description and moves. enrichWithBinary
    // can only pick one value for the record, so without resolving it here every
    // historical snapshot would carry the tip's category — publishing a key as
    // ordinary `settings` in the very versions where it was internal.
    const categorized =
      record.type === 'config_key'
        ? withCategory(record, binaryConfigCategory(eras, version))
        : record;
    // `isCurrentDescriptionEra` asks whether the BINARY help text has changed since
    // this version, and was used as a proxy for whether the docs text still
    // applies. It is not a sound one: `/review`'s binary text is unchanged since
    // 2.1.186, while its docs text describes behaviour that began at 2.1.223, so
    // every snapshot from 2.1.186 on published the later text. The proxy still
    // stands for a description that names nothing later than the version — the
    // guard is what it now defers to.
    if (
      categorized.description !== '' &&
      isCurrentDescriptionEra(eras, version) &&
      !describesFutureState(categorized.description, version, firstSeenByKey, releases)
    )
      return categorized;
    const era = descriptionAt(eras, version);
    return era && era.description !== categorized.description
      ? { ...categorized, description: era.description, description_source: 'binary' }
      : deanachronize(categorized, version);
  };

  return versionsOldestFirst.map((version) => ({
    version,
    symbols: records
      .filter((record) => liveAt(record, version))
      .map((record) =>
        withScopes(
          withFlagVisibility(describeAt(statusAt(record, version), version), version),
          version
        )
      )
      .sort(compareSymbolRecords),
  }));
}

/**
 * Changelog-only snapshots (no docs overlay): every symbol keeps its observed
 * first_seen, the bullet as its description, and confidence "high". Kept for the
 * pure changelog contract and its tests; production uses buildEnrichedSnapshots.
 */
export function buildSnapshots(blocks: ChangelogBlock[]): VersionSnapshot[] {
  const records = [...collectChangelogSymbols(blocks).values()].map(
    (collected) => collected.record
  );
  return assembleSnapshots(records, blocks);
}

/** Canonical key order + omits the optional fields when they don't apply. */
function finalizeRecord(input: SymbolRecord & { first_seen_estimated: boolean }): SymbolRecord {
  return {
    symbol: input.symbol,
    type: input.type,
    first_seen: input.first_seen,
    ...(input.first_seen_estimated ? { first_seen_estimated: true } : {}),
    removed_in: input.removed_in,
    status: input.status,
    provenance: input.provenance,
    confidence: input.confidence,
    description: input.description,
    ...(input.description_source ? { description_source: input.description_source } : {}),
    source_url: input.source_url,
    category: input.category,
  };
}

/**
 * Overlays the official docs lane onto the collected changelog symbols and adds
 * docs-only symbols. Description priority: docs -> introducing bullet -> empty.
 * `first_seen`: a docs `min-version` (authoritative) or an introducing bullet
 * anchors it (confidence "high"); an incidental-only mention or a docs page
 * without a min-version leaves it an upper bound (`first_seen_estimated`,
 * confidence "medium") for the binary lane to correct. An estimate that survives
 * every lane is then frozen against the prior dataset (see freezeEstimatedFirstSeen).
 */
export function enrichSymbols(
  collected: Map<string, CollectedSymbol>,
  docs: DocsIndex,
  latestVersion: string
): SymbolRecord[] {
  const docByKey = new Map(docs.symbols.map((entry) => [`${entry.type}:${entry.symbol}`, entry]));
  const records: SymbolRecord[] = [];

  for (const [key, { record, introducing }] of collected) {
    const doc = docByKey.get(key);
    const observed = record.first_seen;
    let firstSeen = observed;
    let estimated: boolean;
    if (doc?.doc_min_version) {
      // earliest evidence wins if the changelog observed it before the doc's min-version
      firstSeen =
        compareVersionsAsc(doc.doc_min_version, observed) < 0 ? doc.doc_min_version : observed;
      estimated = false;
    } else {
      estimated = !introducing;
    }
    const description = doc ? doc.description : introducing ? record.description : '';
    records.push(
      finalizeRecord({
        symbol: record.symbol,
        type: record.type,
        first_seen: firstSeen,
        first_seen_estimated: estimated,
        removed_in: null,
        status: 'active',
        provenance: 'changelog',
        confidence: estimated ? 'medium' : 'high',
        description,
        description_source: doc ? 'docs' : description ? 'changelog' : undefined,
        source_url: record.source_url,
        category: record.category,
      })
    );
  }

  for (const entry of docs.symbols) {
    if (collected.has(`${entry.type}:${entry.symbol}`)) {
      continue;
    }
    const hasMin = Boolean(entry.doc_min_version);
    records.push(
      finalizeRecord({
        symbol: entry.symbol,
        type: entry.type,
        first_seen: hasMin ? (entry.doc_min_version as string) : latestVersion,
        first_seen_estimated: !hasMin,
        removed_in: null,
        status: 'active',
        provenance: 'docs',
        confidence: hasMin ? 'high' : 'medium',
        description: entry.description,
        description_source: 'docs',
        source_url: `${DOCS_BASE}${entry.doc_page}.md`,
        // A page-declared category wins over the name-based guess. categorize()
        // sees only the symbol name, so it cannot tell a `~/.claude.json`
        // global-config key from a `settings.json` one — they look identical and
        // differ only by which file reads them, which is a fact the page states
        // and the name never carries.
        category: entry.category ?? categorize(entry.symbol, entry.type),
      })
    );
  }

  return records;
}

/**
 * Overlays the binary lane onto the changelog+docs records. Two effects, both
 * grounded in positive extraction evidence (the symbol literally appeared in that
 * version's bundle):
 *
 *  - first_seen correction — when the binary observed a shared symbol EARLIER
 *    than its current first_seen, the earlier version wins and the upper-bound
 *    flag is cleared (confidence -> high). Same "earliest evidence wins" rule the
 *    docs overlay applies to a doc min-version.
 *  - binary-only additions — a symbol no other lane knows is appended as
 *    provenance:"binary" / status:"needs_review" (null source_url, empty
 *    description, confidence "medium"), carrying the observation's conservative
 *    `removed_in` (null unless it cleanly disappeared pre-cliff). Env vars are
 *    gated to first-party ones (isPublishableBinaryEnv); flags proved only by a
 *    subcommand's argv switch publish with their `scopes` when containment
 *    established the owning invocation and are withheld otherwise
 *    (isPublishableBinaryFlag), and the rest are first-party by the extractor's
 *    registration/registry evidence. A symbol
 *    a maintainer has audited (PROMOTED_BINARY_SYMBOLS) is instead published
 *    active/high with a first-party description (still provenance:"binary").
 *
 * Shared (changelog/docs) records keep their own removed_in — the binary lane
 * only corrects first_seen upward-in-time on them, never their lifecycle end;
 * the changelog stays the sole removal authority for confirmed symbols.
 */
export function enrichWithBinary(
  records: SymbolRecord[],
  binary: BinaryObservations,
  binaryDescriptions?: BinaryDescriptions['descriptions']
): SymbolRecord[] {
  const observedByKey = new Map(binary.symbols.map((obs) => [`${obs.type}:${obs.symbol}`, obs]));

  const merged = records.map((record) => {
    const obs = observedByKey.get(`${record.type}:${record.symbol}`);
    if (!obs || compareVersionsAsc(obs.first_seen, record.first_seen) >= 0) {
      return record;
    }
    // A switch-case-only observation is subcommand-scoped, so it says nothing about
    // when the top-level flag of the same name appeared — it must not re-date it.
    // This stays gated on the scope caveat itself, NOT on publishability: a scoped
    // flag publishes now, but `--capacity` is still one record spanning both
    // `remote-control` (older, from docs) and `self-hosted-runner` (2.1.224), and
    // the runner's sighting is the wrong answer to "when did --capacity appear?".
    if (!mayRedateFromBinary(obs)) {
      return record;
    }
    // Binary saw the symbol earlier than any other lane — earliest evidence wins.
    return finalizeRecord({
      ...record,
      first_seen: obs.first_seen,
      first_seen_estimated: false,
      confidence: 'high',
    });
  });

  const known = new Set(records.map((record) => `${record.type}:${record.symbol}`));
  for (const obs of binary.symbols) {
    if (known.has(`${obs.type}:${obs.symbol}`)) {
      continue;
    }
    // A config key's internal-ness lives in its description, which categorize()
    // never sees; every other type it handles from the name alone.
    const baseCategory =
      obs.type === 'config_key'
        ? binaryConfigCategory(binaryDescriptions?.[`${obs.type}:${obs.symbol}`], obs.last_seen)
        : categorize(obs.symbol, obs.type);
    if (obs.type === 'env_var' && !isPublishableBinaryEnv(obs.symbol, baseCategory)) {
      // An external env var Claude Code merely reads — left unpublished by omission.
      continue;
    }
    if (!isPublishableBinaryFlag(obs)) {
      // Claude Code's own flag, proved only by a subcommand's argv switch AND with
      // no scope established for it — publishing it into a flat namespace would
      // claim it works on bare `claude`. Recorded in binary-observations.json.
      continue;
    }
    // A maintainer-audited symbol graduates from the needs_review default to
    // active with a first-party description; everything else stays needs_review.
    const promo = promotionFor(obs.type, obs.symbol);
    merged.push(
      finalizeRecord({
        symbol: obs.symbol,
        type: obs.type,
        first_seen: obs.first_seen,
        first_seen_estimated: false,
        removed_in: obs.removed_in,
        status: promo ? 'active' : 'needs_review',
        provenance: 'binary',
        confidence: promo ? 'high' : 'medium',
        description: promo ? promo.description : '',
        description_source: promo ? promo.description_source : undefined,
        source_url: null,
        category:
          obs.type === 'env_var'
            ? binaryEnvCategory(obs.symbol, baseCategory)
            : obs.type === 'cli_flag'
              ? binaryFlagCategory(obs.hidden_eras, obs.last_seen, baseCategory)
              : baseCategory,
      })
    );
  }

  return merged;
}

/**
 * Production snapshots: changelog symbols enriched with the official docs lane,
 * then overlaid with the binary lane when `binary` observations are supplied,
 * then retired per the curated changelog-removal list. The binary overlay is
 * optional so the changelog+docs contract (and its tests) stays exercisable on
 * its own; production always supplies it. Removals apply last so a confirmed
 * retirement wins over whatever lane last touched the record's `removed_in`.
 */
/**
 * Freezes a floating first_seen ESTIMATE against the prior dataset. A docs-only
 * symbol with no date evidence gets `latestVersion` as its upper bound, which
 * would otherwise creep forward to the newest release on every scrape (pure
 * churn). Once a lane anchors a symbol its estimate is cleared, so this only
 * touches records still `first_seen_estimated` after the binary lane — and only
 * pulls first_seen EARLIER, to the version we already recorded it at (our own
 * committed history is the timeline). A newly-seen estimate has no prior entry
 * and stays at `latestVersion`, freezing there for every subsequent scrape.
 */
export function freezeEstimatedFirstSeen(
  records: SymbolRecord[],
  priorFirstSeen: ReadonlyMap<string, string>
): SymbolRecord[] {
  return records.map((record) => {
    if (!record.first_seen_estimated) return record;
    const prior = priorFirstSeen.get(`${record.type}:${record.symbol}`);
    return prior !== undefined && compareVersionsAsc(prior, record.first_seen) < 0
      ? { ...record, first_seen: prior }
      : record;
  });
}

export function buildEnrichedSnapshots(
  blocks: ChangelogBlock[],
  docs: DocsIndex,
  binary?: BinaryObservations,
  priorFirstSeen?: ReadonlyMap<string, string>,
  binaryDescriptions?: BinaryDescriptions['descriptions']
): VersionSnapshot[] {
  const collected = collectChangelogSymbols(blocks);
  const latest =
    blocks.map((block) => block.version).sort((a, b) => compareVersionsAsc(b, a))[0] ?? '';
  const enriched = enrichSymbols(collected, docs, latest);
  const withBinary = binary ? enrichWithBinary(enriched, binary, binaryDescriptions) : enriched;
  const withRemovals = applyChangelogRemovals(withBinary);
  const withDeprecations = applyChangelogDeprecations(withRemovals);
  const frozen = priorFirstSeen
    ? freezeEstimatedFirstSeen(withDeprecations, priorFirstSeen)
    : withDeprecations;
  return assembleSnapshots(
    frozen,
    blocks,
    binaryDescriptions,
    binaryScopeMap(binary),
    binaryHiddenMap(binary),
    binary?.observedVersions
  );
}

/**
 * Binary-proved scopes keyed `type:symbol`, for assembleSnapshots to union with
 * the curated table. Only observations that actually carry scopes appear, so a
 * run without the binary lane behaves exactly as before.
 *
 * `from` is the observation's first_seen — the earliest archived binary whose
 * parser proved the scope — and it bounds the claim below. The scope SET is a
 * union over the observation window rather than a per-version timeline, which is
 * exact as long as the set does not change inside that window; at 2.1.224-2.1.226
 * none of the 43 scoped flags changes. Should a flag ever move between
 * subcommands mid-window, this would apply the later scope from `from` onward,
 * and the fix would be scope eras alongside the description ones.
 */
/** Per-flag `--help` visibility timelines, keyed `type:symbol`. */
function binaryHiddenMap(binary?: BinaryObservations): ReadonlyMap<string, readonly HiddenEra[]> {
  const out = new Map<string, readonly HiddenEra[]>();
  for (const obs of binary?.symbols ?? []) {
    if (obs.hidden_eras?.length) out.set(`${obs.type}:${obs.symbol}`, obs.hidden_eras);
  }
  return out;
}

function binaryScopeMap(binary?: BinaryObservations): ReadonlyMap<string, BinaryScopeWindow> {
  const out = new Map<string, BinaryScopeWindow>();
  for (const obs of binary?.symbols ?? []) {
    if (obs.scopes?.length) {
      out.set(`${obs.type}:${obs.symbol}`, { from: obs.first_seen, scopes: obs.scopes });
    }
  }
  return out;
}

/**
 * Loads `data/docs.json`, the committed docs lane. ANY failure — a missing
 * file, malformed/truncated JSON, a permission error — throws, so the scrape
 * fails loudly rather than silently regenerating an incomplete dataset (one
 * that drops every docs-only symbol and reverts descriptions to changelog text)
 * that still passes validation. docs.json is committed and produced by
 * `npm run fetch-docs`; its absence during a scrape is an error, not a
 * fall-back.
 */
export async function loadDocsIndex(path: string): Promise<DocsIndex> {
  return JSON.parse(await readFile(path, 'utf-8')) as DocsIndex;
}

/**
 * Guards the normal scrape path against a *valid but empty* docs index — e.g.
 * fetch-docs succeeded but an upstream table-shape change stopped the parser
 * from matching anything, so `symbols` is `[]`. Enriching against that silently
 * drops every docs-only symbol and description while validation still passes,
 * producing valid-but-incomplete data. Throws so the scrape fails loudly.
 */
export function assertNonEmptyDocs(docs: DocsIndex, path: string): void {
  if (docs.symbols.length === 0) {
    throw new Error(
      `Docs index ${path} has 0 symbols — the docs parser likely broke on an upstream ` +
        `table-shape change. Re-run "npm run fetch-docs" and inspect it.`
    );
  }
}

/**
 * Builds the data/index.json shape from a set of version snapshots: the
 * list of tracked versions sorted numerically descending (newest first) and
 * the newest one called out as `latest`.
 */
export function buildIndex(snapshots: VersionSnapshot[]): SymbolIndex {
  const versions = snapshots
    .map((snapshot) => snapshot.version)
    .sort((a, b) => compareVersionsAsc(b, a));

  return {
    schemaVersion: SCHEMA_VERSION,
    latest: versions[0] ?? '',
    versions,
  };
}

interface SnapshotFile {
  claudeCodeVersion: string;
  schemaVersion: string;
  symbols: SymbolRecord[];
}

function toSnapshotFile(snapshot: VersionSnapshot): SnapshotFile {
  return {
    claudeCodeVersion: snapshot.version,
    schemaVersion: SCHEMA_VERSION,
    symbols: snapshot.symbols,
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/** The committed docs lane — the only docs source; not CLI-overridable. */
const DOCS_PATH = 'data/docs.json';
/** The committed binary lane — the distilled binary evidence; not CLI-overridable. */
const BINARY_OBSERVATIONS_PATH = 'data/binary-observations.json';
/** The committed per-version description timeline; not CLI-overridable. */
const BINARY_DESCRIPTIONS_PATH = 'data/binary-descriptions.json';
/** The committed data directory; regenerating it must use canonical sources. */
const COMMITTED_DATA_DIR = 'data';

/**
 * Reads the `${type}:${symbol}` -> first_seen map used to freeze floating estimates
 * ([[freezeEstimatedFirstSeen]]) from the snapshot already at the output location
 * (the committed `latest.json` in production).
 *
 * ONLY prior records that were themselves `first_seen_estimated` are included, so
 * the freeze can only carry forward a prior ESTIMATE (a first-party-derived
 * upper bound), never adopt an anchored/hand-set date as if it were one — it
 * keeps this a monotonic "an estimate doesn't creep forward" rule, not a channel
 * for generated output to override the first-party lanes. Best-effort: a missing
 * or malformed file (fresh dir, first backfill) yields an empty map, so estimates
 * fall back to `latestVersion` exactly as before — the freeze never fails the scrape.
 */
async function loadPriorFirstSeen(latestPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = await readFile(latestPath, 'utf-8');
  } catch {
    return map; // no prior snapshot (fresh output dir) — nothing to freeze against
  }
  try {
    const snapshot = JSON.parse(raw) as { symbols?: Array<Partial<SymbolRecord>> };
    for (const s of snapshot.symbols ?? []) {
      if (s.type && s.symbol && s.first_seen && s.first_seen_estimated === true) {
        map.set(`${s.type}:${s.symbol}`, s.first_seen);
      }
    }
  } catch {
    return new Map(); // malformed prior snapshot — degrade to no freeze, don't crash
  }
  return map;
}

interface CliOptions {
  changelogPath?: string;
  outDir: string;
  all: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outDir: 'data', all: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changelog' || arg === '--out') {
      const value = argv[i + 1];
      // Error rather than silently dropping the flag: a bare `--out` (no path)
      // would otherwise fall through to the default outDir "data" and silently
      // regenerate the committed dataset (assertCanonicalSourcesForCommittedData
      // only guards the --changelog case). Mirrors backfill-binary.ts parseArgs.
      if (value === undefined) {
        throw new Error(`${arg} requires a path argument (e.g. "${arg} <path>").`);
      }
      if (arg === '--changelog') options.changelogPath = value;
      else options.outDir = value;
      i++;
    } else if (arg === '--all') {
      options.all = true;
    }
  }

  return options;
}

/**
 * Provenance guard: the committed dataset must be regenerated only from
 * canonical sources — the official changelog fetch and the committed
 * `data/docs.json`. `--changelog` (a local file, for in-process CLI tests that
 * write to a scratch `--out`) is refused when the target is the committed
 * `data/` directory, so shipped data can't be produced from a local override.
 */
export function assertCanonicalSourcesForCommittedData(
  outDir: string,
  changelogPath: string | undefined
): void {
  // Resolve both paths so equivalent spellings (data, data/, ./data, an absolute
  // path) are all caught, not just the literal string.
  const writesCommittedData = resolve(outDir) === resolve(COMMITTED_DATA_DIR);
  if (writesCommittedData && changelogPath !== undefined) {
    throw new Error(
      `Refusing to regenerate the committed ${COMMITTED_DATA_DIR}/ directory from a local ` +
        `--changelog override; the shipped dataset must come from the official CHANGELOG.md ` +
        `fetch. Use --changelog only with a scratch --out (as the CLI tests do).`
    );
  }
}

export async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  assertCanonicalSourcesForCommittedData(options.outDir, options.changelogPath);
  const md = await loadChangelog(options.changelogPath);

  const blocks = parseChangelog(md);
  const docs = await loadDocsIndex(DOCS_PATH);
  assertNonEmptyDocs(docs, DOCS_PATH);
  // Defense-in-depth integrity check on the committed docs.json.
  assertOfficialDocs(docs);
  const binary = await loadBinaryObservations(BINARY_OBSERVATIONS_PATH);
  assertBinaryObservations(binary, BINARY_OBSERVATIONS_PATH);
  const binaryDescriptions = await loadBinaryDescriptions(BINARY_DESCRIPTIONS_PATH);
  assertBinaryDescriptions(binaryDescriptions, BINARY_DESCRIPTIONS_PATH);
  // Freeze floating first_seen estimates against the snapshot already at the
  // output location (the committed latest.json when regenerating data/).
  const priorFirstSeen = await loadPriorFirstSeen(join(options.outDir, 'latest.json'));
  const snapshots = buildEnrichedSnapshots(
    blocks,
    docs,
    binary,
    priorFirstSeen,
    binaryDescriptions.descriptions
  );
  const index = buildIndex(snapshots);

  const sortedByVersion = [...snapshots].sort((a, b) => compareVersionsAsc(a.version, b.version));
  const latestSnapshot = sortedByVersion[sortedByVersion.length - 1];

  await mkdir(options.outDir, { recursive: true });

  if (options.all) {
    const versionsDir = join(options.outDir, 'versions');
    await mkdir(versionsDir, { recursive: true });
    for (const snapshot of snapshots) {
      await writeJson(join(versionsDir, `${snapshot.version}.json`), toSnapshotFile(snapshot));
    }
  }

  await writeJson(join(options.outDir, 'index.json'), index);
  if (latestSnapshot) {
    await writeJson(join(options.outDir, 'latest.json'), toSnapshotFile(latestSnapshot));
  }

  const writtenCount = options.all ? snapshots.length : latestSnapshot ? 1 : 0;
  console.log(
    `Scraped ${blocks.length} changelog version(s); wrote ${writtenCount} snapshot file(s) to ${options.outDir}`
  );

  return 0;
}

// Only run the CLI when this file is executed directly (e.g. via `tsx
// scripts/scrape-changelog.ts` or `npm run scrape`), not when it's imported
// by tests or other modules.
if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Unexpected error while scraping the changelog:', err);
      process.exitCode = 1;
    });
}
