#!/usr/bin/env node
// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-merge safety guard for the changelog-update bot.
 *
 * The bot regenerates the whole dataset every run, from three lanes (changelog,
 * docs, binary). Only the changelog lane is self-checking; a docs- or binary-lane
 * parser that quietly stops matching an upstream page still produces a green PR
 * that guts a lane. `validate` and the test suite do not catch that — the output
 * is well-formed, just smaller. So a PR must not auto-merge on green checks alone.
 *
 * This guard compares the newly generated tip snapshot (`data/latest.json`)
 * against the one on the base branch and decides whether the change is a SAFE
 * INCREMENTAL ADD. It reuses `diffSnapshots`, then applies four floors. A change
 * that trips any floor is left for a human; a clean incremental add is cleared
 * for auto-merge. The decision is advisory output, not an error: an unsafe
 * verdict exits 0 so it never trips the workflow's failure path.
 *
 * The verdict is written to `$GITHUB_OUTPUT` as `auto_merge=true|false` when that
 * env var is set, and always printed. The workflow enables auto-merge only on
 * `true`.
 *
 * Scope note: the bot gates auto-merge on the HOURLY, single-version path only
 * (a new upstream release). Manual `workflow_dispatch` runs — forced re-scrapes,
 * multi-version backfills, the large first backfill — always stay manual, so the
 * floors here are tuned for the one-new-version case.
 *
 * Usage:
 *   tsx scripts/check-auto-merge.ts <baseFile> <nextFile>
 */
import { appendFile, readFile } from 'node:fs/promises';

import { diffSnapshots, type SymbolCollection } from './diff-snapshots.js';
import { runCli } from './lib.js';
import type { SymbolRecord } from './scrape-changelog.js';

export interface AutoMergeVerdict {
  /** True when the change is a safe incremental add and may auto-merge. */
  safe: boolean;
  /** One line per tripped floor, empty when `safe`. */
  reasons: string[];
  added: number;
  removed: number;
  changed: number;
  prevTotal: number;
  nextTotal: number;
}

/**
 * Joins `names` with commas, capped at `limit` so a catastrophic diff (a whole
 * lane gone is hundreds of names) does not flood the run log. The count in the
 * reason line is the full total, so nothing is hidden — only the sample is cut.
 */
function sampleNames(names: string[], limit = 15): string {
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')}, ... (+${names.length - limit} more)`;
}

/** Counts records by the value of `key`, e.g. `type` or `provenance`. */
function countBy(symbols: SymbolRecord[], key: 'type' | 'provenance'): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of symbols) {
    counts.set(record[key], (counts.get(record[key]) ?? 0) + 1);
  }
  return counts;
}

/**
 * Reports every value of `key` whose count DROPPED from `prev` to `next`. A lane
 * that stops matching shows up here as its `type`/`provenance` count falling —
 * the "silently gutted lane" this guard exists to catch. A value missing from
 * `next` counts as zero, so a whole category disappearing is caught too.
 */
function floorDrops(
  prev: SymbolRecord[],
  next: SymbolRecord[],
  key: 'type' | 'provenance'
): string[] {
  const prevCounts = countBy(prev, key);
  const nextCounts = countBy(next, key);
  const drops: string[] = [];
  for (const [value, before] of prevCounts) {
    const after = nextCounts.get(value) ?? 0;
    if (after < before) {
      drops.push(`${key} "${value}" dropped ${before} -> ${after}`);
    }
  }
  return drops;
}

/**
 * Decides whether `next` is a safe incremental add over `prev`. Floors, each of
 * which blocks auto-merge:
 *
 * 1. No removals. A symbol present on the base but gone from `next` is either a
 *    genuine upstream retirement or a gutted lane; both want human eyes.
 * 2. No `type` count drop (cli_flag, env_var, command, config_key, ...).
 * 3. No `provenance` count drop (changelog, docs, binary) — catches a lane that
 *    silently stopped contributing even when the total holds.
 * 4. No `first_seen` change on a symbol present in both. Re-dating history is a
 *    deliberate forced-backfill action, never something the hourly one-version
 *    run should produce; if it appears here, something is wrong.
 */
export function evaluateAutoMerge(
  prev: SymbolCollection,
  next: SymbolCollection
): AutoMergeVerdict {
  const diff = diffSnapshots(prev, next);
  const reasons: string[] = [];

  if (diff.removed.length > 0) {
    const names = sampleNames(diff.removed.map((r) => `${r.type}:${r.symbol}`));
    reasons.push(`${diff.removed.length} symbol(s) removed from the snapshot: ${names}`);
  }

  reasons.push(...floorDrops(prev.symbols, next.symbols, 'type'));
  reasons.push(...floorDrops(prev.symbols, next.symbols, 'provenance'));

  const redated = diff.changed.filter((c) => c.before.first_seen !== c.after.first_seen);
  if (redated.length > 0) {
    const names = sampleNames(
      redated.map((c) => `${c.key} (${c.before.first_seen} -> ${c.after.first_seen})`)
    );
    reasons.push(`${redated.length} symbol(s) had first_seen re-dated: ${names}`);
  }

  return {
    safe: reasons.length === 0,
    reasons,
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    prevTotal: prev.symbols.length,
    nextTotal: next.symbols.length,
  };
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

function printVerdict(verdict: AutoMergeVerdict): void {
  console.log(
    `Snapshot: ${verdict.prevTotal} -> ${verdict.nextTotal} symbols ` +
      `(+${verdict.added} / -${verdict.removed} / ~${verdict.changed})`
  );
  if (verdict.safe) {
    console.log('Auto-merge: SAFE — clean incremental add, no floor tripped.');
    return;
  }
  console.log('Auto-merge: WITHHELD — needs human review:');
  for (const reason of verdict.reasons) {
    // ::notice:: not ::error:: — a withheld auto-merge is an expected outcome,
    // not a CI failure, so it must not colour the run red or trip failure alerts.
    console.log(`::notice::${reason}`);
  }
}

/** Appends `auto_merge=<bool>` to `$GITHUB_OUTPUT` when running under Actions. */
async function writeGithubOutput(safe: boolean): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await appendFile(outputPath, `auto_merge=${safe ? 'true' : 'false'}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const [basePath, nextPath] = argv;
  if (!basePath || !nextPath) {
    console.error('Usage: check-auto-merge <baseFile> <nextFile>');
    return 1;
  }

  const base = await loadSnapshotFile(basePath);
  const next = await loadSnapshotFile(nextPath);

  const verdict = evaluateAutoMerge(base, next);
  printVerdict(verdict);
  await writeGithubOutput(verdict.safe);

  // Exit 0 for BOTH outcomes: a withheld merge is a normal result, and a
  // non-zero here would fail the job and (later) trip the failure notifier.
  return 0;
}

runCli(import.meta.url, 'checking auto-merge safety', main);
