#!/usr/bin/env node
// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeds `data/docs-history.json` from the git history of `data/docs.json`.
 *
 * Usage:
 *   npx tsx scripts/backfill-docs-history.ts [ref] [out]
 *
 * `ref` defaults to `HEAD` and `out` to `data/docs-history.json`. The walk follows
 * first-parent commits only, so each capture is one that a merged PR published,
 * and dates each capture by the newest release that commit's `index.json` or
 * `data/binary-observations.json` knew (see `captureRelease`).
 *
 * Run it once to create the file. After that `fetch-docs` appends to it, and a
 * re-seed would only reproduce the same eras from the same commits. A shallow
 * clone has no history to read, so this refuses to run in one.
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import {
  DOCS_HISTORY_PATH,
  appendDocsCapture,
  captureRelease,
  emptyDocsHistory,
  type DocsCapture,
} from './docs-history.js';
import { runCli } from './lib.js';

// stderr is piped, not inherited: `git show` of a path a commit lacks is an expected
// miss here, and its "fatal:" line would read as a failure of the seed.
const git = (...args: string[]): string =>
  execFileSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function showJson<T>(commit: string, path: string): T | undefined {
  try {
    return JSON.parse(git('show', `${commit}:${path}`)) as T;
  } catch {
    return undefined;
  }
}

function newestObserved(observed: readonly string[] | undefined): string | undefined {
  return observed && observed.length > 0 ? captureRelease(observed) : undefined;
}

export async function main(argv: string[]): Promise<void> {
  const ref = argv[0] ?? 'HEAD';
  const outPath = argv[1] ?? DOCS_HISTORY_PATH;
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    throw new Error(
      'This clone is shallow, so it holds no docs.json history. Fetch with --unshallow.'
    );
  }
  const commits = git(
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H',
    ref,
    '--',
    'data/docs.json'
  )
    .split('\n')
    .filter(Boolean);
  let history = emptyDocsHistory();
  let captures = 0;
  for (const commit of commits) {
    const docs = showJson<DocsCapture>(commit, 'data/docs.json');
    // A commit that deleted the file, or one that wrote unparseable JSON, is not a capture.
    if (!docs || !Array.isArray(docs.symbols)) continue;
    const index = showJson<{ latest?: string }>(commit, 'data/index.json');
    const binary = showJson<{ observedVersions?: string[] }>(
      commit,
      'data/binary-observations.json'
    );
    const release = captureRelease([index?.latest, newestObserved(binary?.observedVersions)]);
    history = appendDocsCapture(history, docs, release);
    captures += 1;
  }
  if (captures === 0) throw new Error(`No data/docs.json capture found in the history of ${ref}.`);
  await writeFile(outPath, `${JSON.stringify(history, null, 2)}\n`, 'utf-8');
  const eras = Object.values(history.descriptions).reduce((n, e) => n + e.length, 0);
  console.log(
    `Wrote ${outPath}: ${captures} captures, ${Object.keys(history.descriptions).length} symbols, ${eras} eras.`
  );
}

runCli(import.meta.url, 'seeding the docs history', main);
