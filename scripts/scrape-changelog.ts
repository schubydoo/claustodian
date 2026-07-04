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
 * Usage:
 *   tsx scripts/scrape-changelog.ts [--changelog <path>] [--out <dir>] [--all]
 *
 *   --changelog <path>  Read the changelog from a local file instead of
 *                       fetching https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
 *   --out <dir>         Output directory (default: "data")
 *   --all               Write every version's snapshot under <dir>/versions/,
 *                       plus <dir>/index.json and <dir>/latest.json. Without
 *                       this flag, only <dir>/index.json and <dir>/latest.json
 *                       are written (the full per-version backfill is opt-in).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
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
  removed_in: string | null;
  status: 'active' | 'deprecated' | 'removed' | 'needs_review';
  provenance: 'changelog' | 'binary';
  confidence: 'high' | 'medium' | 'low';
  description: string;
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
 * Builds a cumulative, per-version snapshot of every symbol known so far.
 *
 * Iterates versions oldest -> newest (the reverse of `parseChangelog`'s
 * newest-first file order). For each version, any symbol extracted from its
 * bullets that hasn't been seen before is registered with `first_seen` set
 * to that version and `description` set to the exact bullet text it was
 * found in (minus the leading "- "). Once registered, a symbol's
 * first_seen/description never change on re-mention. Each version's
 * snapshot contains every symbol known as of (and including) that version,
 * sorted deterministically by type then symbol name.
 */
export function buildSnapshots(blocks: ChangelogBlock[]): VersionSnapshot[] {
  const oldestFirst = [...blocks].reverse();
  const known = new Map<string, SymbolRecord>();
  const snapshots: VersionSnapshot[] = [];

  for (const block of oldestFirst) {
    for (const bullet of block.bullets) {
      const symbols = extractSymbols(bullet);
      for (const { symbol, type } of symbols) {
        const key = `${type}:${symbol}`;
        if (known.has(key)) {
          continue;
        }
        known.set(key, {
          symbol,
          type,
          first_seen: block.version,
          removed_in: null,
          status: 'active',
          provenance: 'changelog',
          confidence: 'high',
          description: bulletDescription(bullet),
          source_url: SOURCE_URL,
          category: 'uncategorized',
        });
      }
    }

    const symbolsSnapshot = [...known.values()].sort(compareSymbolRecords);
    snapshots.push({ version: block.version, symbols: symbolsSnapshot });
  }

  return snapshots;
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

async function loadChangelog(changelogPath: string | undefined): Promise<string> {
  if (changelogPath) {
    return readFile(changelogPath, 'utf-8');
  }

  const response = await fetch(CHANGELOG_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch changelog from ${CHANGELOG_URL}: ${response.status} ${response.statusText}`
    );
  }
  return response.text();
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const md = await loadChangelog(options.changelogPath);

  const blocks = parseChangelog(md);
  const snapshots = buildSnapshots(blocks);
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
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Unexpected error while scraping the changelog:', err);
      process.exitCode = 1;
    });
}
