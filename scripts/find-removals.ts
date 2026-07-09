// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Maintainer tool — the "propose" half of the changelog removal lane
 * ([[scripts/removals.ts]]). Reads the changelog (fetched, or `--changelog
 * <file>`), runs the tight-grammar candidate extractor, and prints the retirement
 * bullets that (a) name a symbol the dataset already knows and (b) aren't already
 * confirmed in `CONFIRMED_REMOVALS`. Run it after each release; confirm the real
 * retirements into `scripts/removals.ts`. It only reports — it never writes data.
 *
 * Usage: tsx scripts/find-removals.ts [--changelog <file>] [--dataset <latest.json>]
 */
import { readFile } from 'node:fs/promises';

import { isMain, loadChangelog } from './lib.js';
import { CONFIRMED_REMOVALS, extractRemovalCandidates } from './removals.js';

const DEFAULT_DATASET = 'data/latest.json';

interface Options {
  changelogPath?: string;
  datasetPath: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { datasetPath: DEFAULT_DATASET };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changelog' || arg === '--dataset') {
      // Require an explicit value: a bare flag must not silently fall back to the
      // default (a typo would scan the wrong inputs and still report "up to date").
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a path`);
      if (arg === '--changelog') options.changelogPath = value;
      else options.datasetPath = value;
    }
  }
  return options;
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const markdown = await loadChangelog(options.changelogPath);
  const dataset = JSON.parse(await readFile(options.datasetPath, 'utf-8')) as {
    symbols: Array<{ symbol: string }>;
  };

  const known = new Set(dataset.symbols.map((s) => s.symbol));
  const confirmed = new Set(CONFIRMED_REMOVALS.map((r) => r.symbol));
  const candidates = extractRemovalCandidates(markdown).filter(
    (c) => known.has(c.symbol) && !confirmed.has(c.symbol)
  );

  if (candidates.length === 0) {
    console.log('No new removal candidates — CONFIRMED_REMOVALS is up to date.');
    return 0;
  }
  console.log(
    `${candidates.length} removal candidate(s) to review — confirm real retirements in scripts/removals.ts:\n`
  );
  for (const c of candidates) {
    console.log(`[${c.version}] ${c.verb} ${c.symbol}`);
    console.log(`    ${c.text}`);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
