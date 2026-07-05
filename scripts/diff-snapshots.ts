#!/usr/bin/env node
// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Snapshot diff utility for Claustodian.
 *
 * Compares two per-version symbol snapshots (the same `{ claudeCodeVersion,
 * schemaVersion, symbols }` shape written by `scrape-changelog.ts` and read
 * by `validate-schema.ts`) and reports which symbols were added, removed, or
 * changed between them.
 *
 * This is general-purpose removal-detection infrastructure: the changelog
 * lane only ever adds symbols (see `scrape-changelog.ts`'s `buildSnapshots`
 * doc comment), so `diffSnapshots` mostly reports `added` today. The binary
 * lane (Section 5.3 of the plan) will reuse this same function to diff two
 * versions' full extracted string sets and surface genuine removals.
 *
 * Usage:
 *   tsx scripts/diff-snapshots.ts <prevFile> <nextFile>
 */
import { readFile } from 'node:fs/promises';

import { isMain } from './lib.js';
import type { SymbolRecord } from './scrape-changelog.js';

export type { SymbolRecord };

/** Minimal shape `diffSnapshots` needs; matches the on-disk snapshot file. */
export interface SymbolCollection {
  symbols: SymbolRecord[];
}

export interface ChangedSymbol {
  key: string;
  before: SymbolRecord;
  after: SymbolRecord;
}

export interface SnapshotDiff {
  added: SymbolRecord[];
  removed: SymbolRecord[];
  changed: ChangedSymbol[];
}

function keyFor(record: SymbolRecord): string {
  return `${record.type}:${record.symbol}`;
}

function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Canonical string form of a record used purely for equality comparison
 * (field order doesn't matter, so keys are sorted before stringifying).
 */
function canonicalize(record: SymbolRecord): string {
  return JSON.stringify(record, Object.keys(record).sort());
}

/**
 * Diffs two snapshots' symbol sets, keyed by `${type}:${symbol}`.
 *
 * - `added`: keys present in `next` but not `prev`.
 * - `removed`: keys present in `prev` but not `next`.
 * - `changed`: keys present in both whose record fields differ (deep
 *   comparison of every field, including `before`/`after` for inspection).
 *
 * All three result arrays are sorted deterministically by key.
 */
export function diffSnapshots(prev: SymbolCollection, next: SymbolCollection): SnapshotDiff {
  const prevByKey = new Map<string, SymbolRecord>();
  for (const record of prev.symbols) {
    prevByKey.set(keyFor(record), record);
  }

  const nextByKey = new Map<string, SymbolRecord>();
  for (const record of next.symbols) {
    nextByKey.set(keyFor(record), record);
  }

  const added: SymbolRecord[] = [];
  for (const [key, record] of nextByKey) {
    if (!prevByKey.has(key)) {
      added.push(record);
    }
  }

  const removed: SymbolRecord[] = [];
  const changed: ChangedSymbol[] = [];
  for (const [key, beforeRecord] of prevByKey) {
    const afterRecord = nextByKey.get(key);
    if (!afterRecord) {
      removed.push(beforeRecord);
      continue;
    }
    if (canonicalize(beforeRecord) !== canonicalize(afterRecord)) {
      changed.push({ key, before: beforeRecord, after: afterRecord });
    }
  }

  added.sort((a, b) => compareKeys(keyFor(a), keyFor(b)));
  removed.sort((a, b) => compareKeys(keyFor(a), keyFor(b)));
  changed.sort((a, b) => compareKeys(a.key, b.key));

  return { added, removed, changed };
}

async function loadSnapshotFile(filePath: string): Promise<SymbolCollection> {
  const raw = await readFile(filePath, 'utf-8');
  const data: unknown = JSON.parse(raw);
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { symbols?: unknown }).symbols)
  ) {
    throw new Error(`${filePath} does not look like a snapshot file (missing "symbols" array)`);
  }
  return data as SymbolCollection;
}

function printSummary(prevPath: string, nextPath: string, diff: SnapshotDiff): void {
  console.log(`Diff ${prevPath} -> ${nextPath}`);
  console.log(`  added:   ${diff.added.length}`);
  console.log(`  removed: ${diff.removed.length}`);
  console.log(`  changed: ${diff.changed.length}`);

  if (diff.added.length > 0) {
    console.log('\nAdded symbols:');
    for (const record of diff.added) {
      console.log(`  + [${record.type}] ${record.symbol}`);
    }
  }

  if (diff.removed.length > 0) {
    console.log('\nRemoved symbols:');
    for (const record of diff.removed) {
      console.log(`  - [${record.type}] ${record.symbol}`);
    }
  }

  if (diff.changed.length > 0) {
    console.log('\nChanged symbols:');
    for (const { key } of diff.changed) {
      console.log(`  ~ ${key}`);
    }
  }
}

export async function main(): Promise<number> {
  const [prevPath, nextPath] = process.argv.slice(2);
  if (!prevPath || !nextPath) {
    console.error('Usage: diff-snapshots <prevFile> <nextFile>');
    return 1;
  }

  let prev: SymbolCollection;
  let next: SymbolCollection;
  try {
    prev = await loadSnapshotFile(prevPath);
    next = await loadSnapshotFile(nextPath);
  } catch (err) {
    console.error(
      `Failed to read/parse snapshot file(s): ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }

  const diff = diffSnapshots(prev, next);
  printSummary(prevPath, nextPath, diff);

  return 0;
}

// Only run the CLI when this file is executed directly (e.g. via `tsx
// scripts/diff-snapshots.ts` or `npm run diff`), not when it's imported by
// tests or other modules.
if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('Unexpected error while diffing snapshots:', err);
      process.exitCode = 1;
    });
}
