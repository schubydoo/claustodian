#!/usr/bin/env node
// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage gate for Claustodian.
 *
 * Every symbol the scraper extracts from the upstream changelog should show up
 * somewhere in the committed dataset. This script re-parses the changelog with
 * the *same* symbol-inclusion logic the scraper uses (`parseChangelog` +
 * `collectChangelogSymbols` from `scrape-changelog.ts`) and reports any
 * `type:symbol` that the scraper silently failed to carry into the dataset —
 * the CI guard against a regression in the scraper (or a hand-edited dataset)
 * quietly dropping symbols the changelog documents. Using
 * `collectChangelogSymbols` (rather than the broader raw `extractSymbols`) keeps
 * this gate in agreement with what the scraper legitimately excludes — a
 * subprocess tool's own example flags (git's, etc.) and phantom flags — so it
 * doesn't demand symbols that aren't Claude Code's. A symbol that only the changelog
 * supports is withheld by the scrape (see `uncorroboratedBy`), so it is not a gap here
 * either.
 *
 * Usage:
 *   tsx scripts/check-coverage.ts [--changelog <path>] [--dataset <path>]
 *
 *   --changelog <path>  Read the changelog from a local file instead of
 *                       fetching https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
 *   --dataset <path>    Snapshot file to check coverage against
 *                       (default: "data/latest.json")
 *   --docs <path>       Docs index (default: "data/docs.json")
 *   --binary <path>     Binary observations (default: "data/binary-observations.json")
 *   --withheld-since <version>
 *                       Instead of checking, print the withheld symbols that the
 *                       changelog first names after <version>, space-separated
 */
import { readFile } from 'node:fs/promises';

import { loadBinaryObservations } from './binary-lane.js';
import { compareVersionsAsc, runCli, loadChangelog } from './lib.js';
import { CONFIRMED_REMOVALS } from './removals.js';
import {
  collectChangelogSymbols,
  loadDocsIndex,
  parseChangelog,
  uncorroboratedBy,
} from './scrape-changelog.js';
import type { SymbolRecord } from './scrape-changelog.js';

export interface MissingSymbol {
  symbol: string;
  type: string;
}

function keyFor(symbol: string, type: string): string {
  return `${type}:${symbol}`;
}

function compareKeys(a: string, b: string): number {
  /* v8 ignore next -- comparator inputs are distinct type:symbol keys (collectChangelogSymbols dedupes by that key), so equality cannot occur */
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Extracts every `{type, symbol}` mentioned anywhere in the changelog, and
 * returns the subset (deduped, sorted deterministically by `type:symbol`)
 * that is NOT present in `datasetSymbols` (matched by the same
 * `type:symbol` key the rest of the tooling uses).
 */
export function findMissingCoverage(
  changelogMd: string,
  datasetSymbols: SymbolRecord[],
  uncorroborated: (type: string, symbol: string) => boolean = () => false
): MissingSymbol[] {
  const known = new Set(datasetSymbols.map((record) => keyFor(record.symbol, record.type)));
  // A confirmed removal is mentioned in the changelog (in its own "Removed `X`"
  // bullet) yet is legitimately ABSENT from latest.json — the removal lane vanished
  // it from post-removal snapshots. Excluding these keeps the gate from demanding a
  // symbol the dataset intentionally dropped. (Deprecations still appear, so they
  // are covered normally.)
  const removed = new Set(CONFIRMED_REMOVALS.map((r) => keyFor(r.symbol, r.type)));
  // The scrape publishes no mod_method record until data/mod-observations.json exists
  // (see buildEnrichedSnapshots). Until the dataset carries the type, a changelog
  // mention of one is not a gap. Once it does, the scrape's own regression guard
  // refuses to lose the file, so the type stays enforced here.
  const publishesMods = datasetSymbols.some((record) => record.type === 'mod_method');

  const blocks = parseChangelog(changelogMd);
  const missing: MissingSymbol[] = [];

  // collectChangelogSymbols already dedupes (first appearance wins) and applies
  // the scraper's exclusions, so we just diff its symbol set against the dataset.
  for (const { record } of collectChangelogSymbols(blocks).values()) {
    if (record.type === 'mod_method' && !publishesMods) continue;
    if (uncorroborated(record.type, record.symbol)) continue;
    const key = keyFor(record.symbol, record.type);
    if (!known.has(key) && !removed.has(key)) {
      missing.push({ symbol: record.symbol, type: record.type });
    }
  }

  missing.sort((a, b) => compareKeys(keyFor(a.symbol, a.type), keyFor(b.symbol, b.type)));
  return missing;
}

/**
 * The changelog symbols the scrape withholds, first named after `since`, in changelog
 * order. The bot PR lists them, so a real symbol the extractor misses is visible.
 */
export function findWithheld(
  changelogMd: string,
  uncorroborated: (type: string, symbol: string) => boolean,
  since: string
): string[] {
  const blocks = parseChangelog(changelogMd);
  return [...collectChangelogSymbols(blocks).values()]
    .map(({ record }) => record)
    .filter(
      (record) =>
        compareVersionsAsc(record.first_seen, since) > 0 &&
        uncorroborated(record.type, record.symbol)
    )
    .map((record) => record.symbol);
}

interface CliOptions {
  changelogPath?: string;
  datasetPath: string;
  docsPath: string;
  binaryPath: string;
  withheldSince?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    datasetPath: 'data/latest.json',
    docsPath: 'data/docs.json',
    binaryPath: 'data/binary-observations.json',
  };
  const valueOf = (flag: string, value: string | undefined): string => {
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a path argument`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changelog') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--changelog requires a path argument');
      }
      options.changelogPath = value;
      i++;
    } else if (arg === '--dataset') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--dataset requires a path argument');
      }
      options.datasetPath = value;
      i++;
    } else if (arg === '--docs') {
      options.docsPath = valueOf(arg, argv[++i]);
    } else if (arg === '--binary') {
      options.binaryPath = valueOf(arg, argv[++i]);
    } else if (arg === '--withheld-since') {
      options.withheldSince = valueOf(arg, argv[++i]);
    }
  }

  return options;
}

interface DatasetFile {
  symbols: SymbolRecord[];
}

async function loadDataset(datasetPath: string): Promise<SymbolRecord[]> {
  const raw = await readFile(datasetPath, 'utf-8');
  const data = JSON.parse(raw) as DatasetFile;
  if (!Array.isArray(data.symbols)) {
    throw new Error(`${datasetPath} does not look like a snapshot file (missing "symbols" array)`);
  }
  return data.symbols;
}

export async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  let md: string;
  let datasetSymbols: SymbolRecord[];
  let uncorroborated: (type: string, symbol: string) => boolean;
  try {
    md = await loadChangelog(options.changelogPath);
    datasetSymbols = await loadDataset(options.datasetPath);
    uncorroborated = uncorroboratedBy(
      await loadDocsIndex(options.docsPath),
      await loadBinaryObservations(options.binaryPath)
    );
  } catch (err) {
    console.error(
      `Failed to load changelog/dataset: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }

  if (options.withheldSince !== undefined) {
    console.log(findWithheld(md, uncorroborated, options.withheldSince).join(' '));
    return 0;
  }

  const missing = findMissingCoverage(md, datasetSymbols, uncorroborated);

  console.log(`${missing.length} changelog symbol(s) missing from ${options.datasetPath}`);
  if (missing.length > 0) {
    console.log('First missing symbol(s):');
    for (const { symbol, type } of missing.slice(0, 20)) {
      console.log(`  [${type}] ${symbol}`);
    }
  }

  return missing.length > 0 ? 1 : 0;
}

// Only run the CLI when this file is executed directly (e.g. via `tsx
// scripts/check-coverage.ts` or `npm run coverage`), not when it's imported
// by tests or other modules.
runCli(import.meta.url, 'checking coverage', main);
