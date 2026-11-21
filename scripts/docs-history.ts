// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * The docs description timeline: what the official docs said about each symbol,
 * captured each time `fetch-docs` ran, keyed to the newest release known then.
 *
 * `data/docs.json` is one capture of the CURRENT docs, so on its own it can only
 * describe the tip. Before this file, a historical snapshot took that tip text and
 * the anachronism guard cut away whatever named a later release or symbol. When
 * the first sentence named one, nothing was left: `plugin.register` was empty in
 * every snapshot from 2.1.269 to 2.1.325, although the docs text current in those
 * releases described them correctly.
 *
 * Each era holds from its `from` release until the next era. A `null` description
 * means the docs did not document the symbol from that release on, so the
 * resolver answers "no docs text then" instead of carrying an older or a newer
 * text across the gap.
 *
 * ⚠️ Unlike `data/binary-descriptions.json`, this file is SELF-REFERENTIAL: each
 * `fetch-docs` run reads the committed file and appends to it. There is no archive
 * of past docs pages to rebuild it from. `scripts/backfill-docs-history.ts` seeds it
 * from the git history of `data/docs.json`, which is the only record of what the
 * docs said before the file existed.
 */
import { readFile } from 'node:fs/promises';
import { compareVersionsAsc } from './lib.js';

export const DOCS_HISTORY_PATH = 'data/docs-history.json';
const GENERATED_BY = 'scripts/fetch-docs.ts';
const SOURCE = 'docs';
const NOTE =
  'Per-symbol timeline of the official docs description, one era per change, keyed to ' +
  'the newest Claude Code release known when the docs were fetched. Each era holds from ' +
  'its release until the next; null means the docs did not document the symbol then. ' +
  'Appended by scripts/fetch-docs.ts, seeded by scripts/backfill-docs-history.ts; ' +
  'consumed by scripts/scrape-changelog.ts.';

export interface DocsEra {
  from: string;
  description: string | null;
}

export interface DocsHistory {
  $generated_by: string;
  source: string;
  note: string;
  descriptions: Record<string, DocsEra[]>;
}

/** The fields of a `data/docs.json` entry that the timeline reads. */
export interface DocsCapture {
  symbols: ReadonlyArray<{ type: string; symbol: string; description: string }>;
}

export function emptyDocsHistory(): DocsHistory {
  return { $generated_by: GENERATED_BY, source: SOURCE, note: NOTE, descriptions: {} };
}

/**
 * The release a docs capture describes: the newest release either lane knows.
 *
 * Neither lane alone is right. In a release-bot run `fetch-docs` runs after the new
 * binary is scraped but before the changelog snapshot is written, so `index.json`
 * still names the previous release. The binary lane, in turn, fell behind the
 * changelog during the 2.1.242 chunk-split outage.
 */
export function captureRelease(candidates: ReadonlyArray<string | null | undefined>): string {
  const known = candidates.filter((v): v is string => typeof v === 'string' && v !== '');
  if (known.length === 0) {
    throw new Error(
      'Cannot date a docs capture: no release is known from index.json or the binary lane.'
    );
  }
  return known.reduce((a, b) => (compareVersionsAsc(a, b) >= 0 ? a : b));
}

/**
 * Records one docs capture as of `release`. A symbol whose text is unchanged gets
 * no new era. A capture at the same release as the last era replaces that era,
 * because both describe the same release and the later fetch is the better one. A
 * symbol the capture no longer documents gets a `null` era.
 *
 * Refuses a capture older than the timeline's newest era: appending it would
 * reorder history, and the resolver relies on ascending eras.
 */
export function appendDocsCapture(
  history: DocsHistory,
  capture: DocsCapture,
  release: string
): DocsHistory {
  const descriptions: Record<string, DocsEra[]> = {};
  for (const [key, eras] of Object.entries(history.descriptions)) {
    const last = eras[eras.length - 1];
    if (last && compareVersionsAsc(release, last.from) < 0) {
      throw new Error(
        `Docs capture for ${release} is older than the timeline's era ${last.from} for ` +
          `${key}; refusing to reorder the docs history.`
      );
    }
    descriptions[key] = [...eras];
  }
  const set = (key: string, description: string | null): void => {
    const eras = descriptions[key] ?? [];
    const last = eras[eras.length - 1];
    if (last?.description === description) return;
    if (last?.from === release) {
      eras.pop();
      // Replacing the era can make it equal to the one before it; drop it then, so
      // the timeline keeps one era per change. A timeline never starts with null.
      const before = eras[eras.length - 1];
      if (before?.description !== description && (before !== undefined || description !== null))
        eras.push({ from: release, description });
    } else if (last !== undefined || description !== null) {
      eras.push({ from: release, description });
    }
    if (eras.length > 0) descriptions[key] = eras;
    else delete descriptions[key];
  };
  const seen = new Set<string>();
  for (const entry of capture.symbols) {
    const key = `${entry.type}:${entry.symbol}`;
    seen.add(key);
    set(key, entry.description);
  }
  for (const key of Object.keys(descriptions)) if (!seen.has(key)) set(key, null);
  return { ...emptyDocsHistory(), descriptions: sortKeys(descriptions) };
}

function sortKeys(descriptions: Record<string, DocsEra[]>): Record<string, DocsEra[]> {
  const sorted: Record<string, DocsEra[]> = {};
  for (const key of Object.keys(descriptions).sort()) sorted[key] = descriptions[key]!;
  return sorted;
}

/** The docs text nearest to a release, and whether it was current at that release. */
export interface DocsText {
  text: string;
  /** The release the docs text was first captured at. */
  from: string;
  /**
   * True when the docs said this while `version` was the newest release. False when
   * `version` predates the symbol's first capture, so the text is the earliest one
   * on record and is LATER than `version`, the same standing the tip text has.
   */
  contemporaneous: boolean;
}

/**
 * The docs text nearest to `version`: the era in effect then, or the first era
 * when `version` predates the timeline. Undefined only when the timeline is empty.
 *
 * An era with no docs text, a `null` one or an empty string, answers with an empty
 * `text`. That is evidence too: the docs of that time had nothing to say, so the
 * caller must not reach for the tip text instead.
 *
 * The docs often trail a release. `plugin.register` changed in 2.1.326, but its
 * docs text changed only when 2.1.330 was the newest release, and the new text says
 * "on v2.1.326 or later". So a LATER era also counts as current at `version` when
 * `namedRelease` dates something in it after the era in effect began and no later
 * than `version`: the docs had caught up with a change that `version` already
 * carries. The nearest such era wins: a newer one can also describe changes after
 * `version` that name nothing the guard can date.
 */
export function docsTextAt(
  eras: readonly DocsEra[] | undefined,
  version: string,
  namedRelease?: (text: string) => string | null
): DocsText | undefined {
  if (!eras || eras.length === 0) return undefined;
  let activeIndex = -1;
  for (const [i, era] of eras.entries()) {
    if (compareVersionsAsc(era.from, version) <= 0) activeIndex = i;
    else break;
  }
  if (activeIndex >= 0 && namedRelease) {
    const activeFrom = eras[activeIndex]!.from;
    for (let j = activeIndex + 1; j < eras.length; j++) {
      const text = eras[j]!.description;
      const named = text === null ? null : namedRelease(text);
      if (
        text !== null &&
        named !== null &&
        compareVersionsAsc(named, activeFrom) > 0 &&
        compareVersionsAsc(named, version) <= 0
      )
        return { text, from: eras[j]!.from, contemporaneous: true };
    }
  }
  const era = eras[Math.max(activeIndex, 0)]!;
  return { text: era.description ?? '', from: era.from, contemporaneous: activeIndex >= 0 };
}

/**
 * Loads the committed timeline. A missing file is legitimate (it returns
 * undefined, and every snapshot uses the tip docs text as before), because the
 * file only exists once its seed data PR lands. Any other failure throws.
 */
export async function loadDocsHistory(path: string): Promise<DocsHistory | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read docs history at ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const history = JSON.parse(raw) as DocsHistory;
  assertDocsHistory(history, path);
  return history;
}

/** Integrity guard: a fetch-docs output whose eras are well-formed and ascending. */
export function assertDocsHistory(history: DocsHistory, path: string): void {
  const fail = (why: string): never => {
    throw new Error(
      `Docs history ${path} ${why}. Re-seed it with "npx tsx scripts/backfill-docs-history.ts".`
    );
  };
  if (history.$generated_by !== GENERATED_BY || history.source !== SOURCE) {
    fail(
      `is not a ${GENERATED_BY} output (got $generated_by=${JSON.stringify(history.$generated_by)}, ` +
        `source=${JSON.stringify(history.source)})`
    );
  }
  if (typeof history.descriptions !== 'object' || history.descriptions === null) {
    fail('is malformed: "descriptions" is not an object');
  }
  for (const [key, eras] of Object.entries(history.descriptions)) {
    if (!Array.isArray(eras) || eras.length === 0) fail(`is malformed: ${key} has no eras`);
    let previous: string | undefined;
    for (const era of eras) {
      if (
        typeof era?.from !== 'string' ||
        (era.description !== null && typeof era.description !== 'string')
      ) {
        fail(
          `is malformed: ${key} has an era without a string from and a string or null description`
        );
      }
      if (previous !== undefined && compareVersionsAsc(previous, era.from) >= 0) {
        fail(`is malformed: ${key} has eras out of order (${previous} then ${era.from})`);
      }
      previous = era.from;
    }
  }
}
