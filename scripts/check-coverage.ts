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
 * doesn't demand symbols that aren't Claude Code's.
 *
 * Usage:
 *   tsx scripts/check-coverage.ts [--changelog <path>] [--dataset <path>]
 *
 *   --changelog <path>  Read the changelog from a local file instead of
 *                       fetching https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
 *   --dataset <path>    Snapshot file to check coverage against
 *                       (default: "data/latest.json")
 */
import { readFile } from 'node:fs/promises';

import { isMain, loadChangelog } from './lib.js';
import { collectChangelogSymbols, parseChangelog } from './scrape-changelog.js';
import type { SymbolRecord } from './scrape-changelog.js';

export interface MissingSymbol {
  symbol: string;
  type: string;
}

function keyFor(symbol: string, type: string): string {
  return `${type}:${symbol}`;
}

function compareKeys(a: string, b: string): number {
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
  datasetSymbols: SymbolRecord[]
): MissingSymbol[] {
  const known = new Set(datasetSymbols.map((record) => keyFor(record.symbol, record.type)));

  const blocks = parseChangelog(changelogMd);
  const missing: MissingSymbol[] = [];

  // collectChangelogSymbols already dedupes (first appearance wins) and applies
  // the scraper's exclusions, so we just diff its symbol set against the dataset.
  for (const { record } of collectChangelogSymbols(blocks).values()) {
    const key = keyFor(record.symbol, record.type);
    if (!known.has(key)) {
      missing.push({ symbol: record.symbol, type: record.type });
    }
  }

  missing.sort((a, b) => compareKeys(keyFor(a.symbol, a.type), keyFor(b.symbol, b.type)));
  return missing;
}

interface CliOptions {
  changelogPath?: string;
  datasetPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { datasetPath: 'data/latest.json' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changelog') {
      const value = argv[i + 1];
      if (value !== undefined) {
        options.changelogPath = value;
        i++;
      }
    } else if (arg === '--dataset') {
      const value = argv[i + 1];
      if (value !== undefined) {
        options.datasetPath = value;
        i++;
      }
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
  try {
    md = await loadChangelog(options.changelogPath);
    datasetSymbols = await loadDataset(options.datasetPath);
  } catch (err) {
    console.error(
      `Failed to load changelog/dataset: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }

  const missing = findMissingCoverage(md, datasetSymbols);

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
if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Unexpected error while checking coverage:', err);
      process.exitCode = 1;
    });
}
