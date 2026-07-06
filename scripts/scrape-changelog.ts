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

import { assertOfficialDocs, DOCS_BASE, type DocsIndex } from './fetch-docs.js';
import { isMain, loadChangelog } from './lib.js';

const SOURCE_URL = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const SCHEMA_VERSION = '1.0.0';

/** One version's worth of raw changelog data, as parsed from the markdown. */
export interface ChangelogBlock {
  version: string;
  bullets: string[];
}

export type ExtractedSymbolType = 'cli_flag' | 'command' | 'env_var';

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
  status: 'active' | 'deprecated' | 'removed' | 'needs_review';
  provenance: 'changelog' | 'docs' | 'binary';
  confidence: 'high' | 'medium' | 'low';
  description: string;
  description_source?: 'docs' | 'changelog';
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
const SYMBOL_DENYLIST: ReadonlySet<string> = new Set([
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
      for (const { symbol, type } of extractSymbols(bullet)) {
        const key = `${type}:${symbol}`;
        if (known.has(key)) {
          continue;
        }
        known.set(key, {
          introducing: isIntroducingBullet(bullet),
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
 * version's snapshot holds every symbol whose `first_seen` is <= that version,
 * sorted deterministically by type then symbol name.
 */
export function assembleSnapshots(
  records: SymbolRecord[],
  blocks: ChangelogBlock[]
): VersionSnapshot[] {
  const versionsOldestFirst = blocks
    .map((block) => block.version)
    .sort((a, b) => compareVersionsAsc(a, b));

  return versionsOldestFirst.map((version) => ({
    version,
    symbols: records
      .filter((record) => compareVersionsAsc(record.first_seen, version) <= 0)
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
 * confidence "medium") for the binary lane to correct.
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

/** Production snapshots: changelog symbols enriched with the official docs lane. */
export function buildEnrichedSnapshots(
  blocks: ChangelogBlock[],
  docs: DocsIndex
): VersionSnapshot[] {
  const collected = collectChangelogSymbols(blocks);
  const latest =
    blocks.map((block) => block.version).sort((a, b) => compareVersionsAsc(b, a))[0] ?? '';
  return assembleSnapshots(enrichSymbols(collected, docs, latest), blocks);
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

function parseVersionParts(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number(part));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Numeric semver comparison (2.1.9 < 2.1.10), ascending. */
export function compareVersionsAsc(a: string, b: string): number {
  const [a1, a2, a3] = parseVersionParts(a);
  const [b1, b2, b3] = parseVersionParts(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
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
/** The committed data directory; regenerating it must use canonical sources. */
const COMMITTED_DATA_DIR = 'data';

interface CliOptions {
  changelogPath?: string;
  outDir: string;
  all: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outDir: 'data', all: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changelog') {
      const value = argv[i + 1];
      if (value !== undefined) {
        options.changelogPath = value;
        i++;
      }
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (value !== undefined) {
        options.outDir = value;
        i++;
      }
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
  const snapshots = buildEnrichedSnapshots(blocks, docs);
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
