#!/usr/bin/env node
// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds a single cross-version catalog from the per-version snapshots under
 * `data/versions/`. Each snapshot is the surface "as of" one version, and the
 * site's default search is scoped to one snapshot — so a symbol that was later
 * removed (e.g. `/dream`, present 2.1.97–2.1.145, removed 2.1.146) is invisible
 * unless you happen to select a version where it still existed.
 *
 * This unions every snapshot into one entry per (type, symbol) ever observed,
 * carrying its lifecycle (`first_seen` / `removed_in` / `deprecated_in`) and the
 * description from the LATEST version it appeared in, plus `last_seen` — the
 * newest snapshot that still contained it (a version the site can jump to). It
 * powers the site's "Search all versions" mode.
 *
 * Derived, not source: like the YAML/TOML exports, this is generated at deploy
 * time (see publish-pages.yml) and never committed, so it can't drift from the
 * snapshots it is built from.
 *
 * Usage:
 *   tsx scripts/build-catalog.ts [--data <dir>]
 *
 * `--data` defaults to `data`; output is written to `<dir>/catalog.json`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { glob } from 'tinyglobby';

import { compareVersionsAsc, isMain } from './lib.js';

interface Snapshot {
  claudeCodeVersion: string;
  symbols: Array<Record<string, unknown> & { symbol: string; type: string }>;
}

export interface CatalogEntry extends Record<string, unknown> {
  symbol: string;
  type: string;
  last_seen: string;
}

const NOTE =
  'Cross-version catalog: one entry per (type, symbol) ever observed across all ' +
  'version snapshots, carrying its lifecycle (first_seen/removed_in/deprecated_in), ' +
  'the description from the latest version it appeared in, and last_seen (the newest ' +
  'snapshot that still contained it). Derived from data/versions/*.json; generated at ' +
  'deploy time, never committed. Powers the site "Search all versions" mode.';

/**
 * Unions per-version snapshots into one catalog entry per symbol. Snapshots are
 * processed oldest-first, so each symbol ends up carrying its newest occurrence
 * (latest description + resolved lifecycle fields) and `last_seen` = that
 * version. Entries are returned sorted by type then symbol (as the lanes are).
 */
export function buildCatalog(snapshots: Snapshot[]): CatalogEntry[] {
  const ascending = [...snapshots].sort((a, b) =>
    compareVersionsAsc(a.claudeCodeVersion, b.claudeCodeVersion)
  );
  const byKey = new Map<string, CatalogEntry>();
  for (const snap of ascending) {
    for (const sym of snap.symbols) {
      byKey.set(`${sym.type}:${sym.symbol}`, { ...sym, last_seen: snap.claudeCodeVersion });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    // Same type ⇒ symbols differ (entries are keyed on type:symbol, so no ties).
    return a.symbol < b.symbol ? -1 : 1;
  });
}

function parseArgs(argv: string[]): { dataDir: string } {
  let dataDir = 'data';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('--data requires a path argument (e.g. "--data <dir>").');
      }
      dataDir = value;
      i++;
    }
  }
  return { dataDir };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { dataDir } = parseArgs(argv);

  const files = await glob(`${dataDir}/versions/*.json`, { absolute: false, dot: false });
  if (files.length === 0) {
    console.log(`No version snapshots under "${dataDir}/versions" (nothing to build).`);
    return 0;
  }

  const snapshots: Snapshot[] = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, 'utf-8')) as Snapshot)
  );
  const symbols = buildCatalog(snapshots);

  const outPath = join(dataDir, 'catalog.json');
  const output = { $generated_by: 'scripts/build-catalog.ts', note: NOTE, symbols };
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');

  console.log(
    `Built ${symbols.length} catalog entries from ${files.length} snapshot(s) into ${outPath}.`
  );
  return 0;
}

// Only run the CLI when executed directly, not when imported by tests.
if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Unexpected error while building the catalog:', err);
      process.exitCode = 1;
    });
}
