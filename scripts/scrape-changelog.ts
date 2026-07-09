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
  binaryEnvCategory,
  type BinaryDescriptions,
  type BinaryObservations,
  descriptionAt,
  isCurrentDescriptionEra,
  isPublishableBinaryEnv,
  loadBinaryDescriptions,
  loadBinaryObservations,
  promotionFor,
} from './binary-lane.js';
import { assertOfficialDocs, DOCS_BASE, type DocsIndex } from './fetch-docs.js';
import { applyChangelogDeprecations, applyChangelogRemovals } from './removals.js';
import { compareVersionsAsc, type ExtractedSymbolType, isMain, loadChangelog } from './lib.js';

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

/** Matches schema/symbol.schema.json exactly. */
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
      if (SYMBOL_DENYLIST.has(symbol)) {
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
 * etc.), listing them as examples — those flags belong to that tool, not Claude
 * Code, so they must not be extracted as `cli_flag` symbols. The tell is a tool
 * name + "flags" + an "(e.g., …)" example list, e.g. the 2.1.30 bullet "Added
 * support for additional `git log` and `git show` flags in read-only mode (e.g.,
 * `--topo-order`, `--cherry-pick`, `--format`, `--raw`)" — which wrongly seeded
 * `--topo-order`/`--cherry-pick`/`--format`/`--raw` (confirmed via the binary
 * lane, which never observes them). Deliberately narrow so it can't suppress a
 * genuine "Added a `--foo` flag for git integration"-style bullet.
 */
const SUBPROCESS_FLAG_BULLET = /\b(?:git|gh|npm|node|docker|ripgrep|rg)\b[^.]*\bflags?\b[^.]*\(e\.g\.,/i;

export function isSubprocessFlagBullet(bullet: string): boolean {
  return SUBPROCESS_FLAG_BULLET.test(bullet);
}

/**
 * The `--flag` tokens a subprocess-flag bullet lists inside its trailing
 * "(e.g., …)" example clause — the subprocess tool's own flags, which must not
 * be extracted as Claude Code `cli_flag` symbols. Scoped to just that
 * parenthetical (not the whole bullet), so a genuine first-party flag appearing
 * elsewhere in the same bullet — e.g. "Added `--foo` for Claude Code and more
 * `git` flags (e.g., `--topo-order`)" — is still recorded. Empty set for any
 * bullet that isn't a subprocess-flag bullet.
 */
export function subprocessFlagExamples(bullet: string): ReadonlySet<string> {
  const flags = new Set<string>();
  if (!isSubprocessFlagBullet(bullet)) {
    return flags;
  }
  // isSubprocessFlagBullet guarantees an "(e.g., …)" clause. Bound the clause to
  // its closing ")" so only the example flags are captured — a real first-party
  // flag before OR after the parenthetical is left for normal extraction.
  const start = bullet.toLowerCase().indexOf('(e.g.,');
  const close = bullet.indexOf(')', start);
  const clause = bullet.slice(start, close === -1 ? undefined : close + 1);
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
 * supplied: a HISTORICAL snapshot gets the description the symbol actually had at
 * that version (from the archived binaries), while the current era keeps the
 * record's curated (docs/changelog) description. Only symbols that already carry a
 * description are touched — this de-anachronizes existing descriptions, it does not
 * invent new ones.
 */
export function assembleSnapshots(
  records: SymbolRecord[],
  blocks: ChangelogBlock[],
  binaryDescriptions?: BinaryDescriptions['descriptions']
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

  // Replace a historical snapshot's description with the one observed in that
  // version's binary; the current era keeps the record's curated description.
  const describeAt = (record: SymbolRecord, version: string): SymbolRecord => {
    if (!binaryDescriptions || record.description === '') return record;
    const eras = binaryDescriptions[`${record.type}:${record.symbol}`];
    if (!eras || eras.length === 0 || isCurrentDescriptionEra(eras, version)) return record;
    const era = descriptionAt(eras, version);
    return era && era.description !== record.description
      ? { ...record, description: era.description, description_source: 'binary' }
      : record;
  };

  return versionsOldestFirst.map((version) => ({
    version,
    symbols: records
      .filter((record) => liveAt(record, version))
      .map((record) => describeAt(statusAt(record, version), version))
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
        category: categorize(entry.symbol, entry.type),
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
 *    gated to first-party ones (isPublishableBinaryEnv); flags and commands are
 *    all first-party by the extractor's registration/registry evidence. A symbol
 *    a maintainer has audited (PROMOTED_BINARY_SYMBOLS) is instead published
 *    active/high with a first-party description (still provenance:"binary").
 *
 * Shared (changelog/docs) records keep their own removed_in — the binary lane
 * only corrects first_seen upward-in-time on them, never their lifecycle end;
 * the changelog stays the sole removal authority for confirmed symbols.
 */
export function enrichWithBinary(
  records: SymbolRecord[],
  binary: BinaryObservations
): SymbolRecord[] {
  const observedByKey = new Map(binary.symbols.map((obs) => [`${obs.type}:${obs.symbol}`, obs]));

  const merged = records.map((record) => {
    const obs = observedByKey.get(`${record.type}:${record.symbol}`);
    if (!obs || compareVersionsAsc(obs.first_seen, record.first_seen) >= 0) {
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
    const baseCategory = categorize(obs.symbol, obs.type);
    if (obs.type === 'env_var' && !isPublishableBinaryEnv(obs.symbol, baseCategory)) {
      // An external env var Claude Code merely reads — left unpublished by omission.
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
          obs.type === 'env_var' ? binaryEnvCategory(obs.symbol, baseCategory) : baseCategory,
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
  const withBinary = binary ? enrichWithBinary(enriched, binary) : enriched;
  const withRemovals = applyChangelogRemovals(withBinary);
  const withDeprecations = applyChangelogDeprecations(withRemovals);
  const frozen = priorFirstSeen
    ? freezeEstimatedFirstSeen(withDeprecations, priorFirstSeen)
    : withDeprecations;
  return assembleSnapshots(frozen, blocks, binaryDescriptions);
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
