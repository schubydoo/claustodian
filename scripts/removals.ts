// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Changelog removal lane — policy + the curated retirement list.
 *
 * The changelog scraper is introduce-only: once a symbol is seen it carries
 * forward into every later snapshot, because "removed" is unsafe to infer from
 * prose. The obvious grammar has a ~75% false-positive rate — "Removed the
 * startup warning — see `/doctor`" MENTIONS /doctor, it does not remove it;
 * dozens of "... no longer ..." bullets are behavior changes, not retirements.
 *
 * So this is a hybrid: `extractRemovalCandidates` proposes with a tight grammar
 * (the symbol must be the grammatical object of Removed/Deprecated), and a human
 * confirms each real retirement into `CONFIRMED_REMOVALS` with the version that
 * announced it. `applyChangelogRemovals` then sets `removed_in`, so the symbol
 * vanishes from every snapshot at/after that version — the same version-accurate
 * mechanic the binary lane uses (the symbol stays present/active in earlier
 * snapshots; absence, not a status flip, is how a removal reads).
 *
 * Deprecations (the symbol still exists, just discouraged) and no-op stubs the
 * binary still observes are a separate, not-yet-modeled signal and are excluded.
 */
import { compareVersionsAsc, type ExtractedSymbolType } from './lib.js';

/** A maintainer-confirmed changelog retirement: this symbol is gone as of `removed_in`. */
export interface ConfirmedRemoval {
  type: ExtractedSymbolType;
  symbol: string;
  /** The version whose changelog announced the removal (the first version without it). */
  removed_in: string;
}

/**
 * The audited retirements (see scratch/needs-review-audit.md workflow). Only
 * symbols where the changelog explicitly retires the symbol itself belong here.
 * Both current entries are corroborated by the binary lane (last observed 2.1.91,
 * i.e. gone at 2.1.92). Judgment calls left out pending review: the `/agents`
 * command (only its wizard was removed — still in the 2.1.201 binary), the
 * `CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE` no-op stub (changelog "Removed" at
 * 2.1.160 but the binary still carries the inert var), and `/output-style`
 * (changelog only "Deprecated" it).
 */
export const CONFIRMED_REMOVALS: readonly ConfirmedRemoval[] = [
  { type: 'command', symbol: '/vim', removed_in: '2.1.92' },
  { type: 'command', symbol: '/tag', removed_in: '2.1.92' },
];

/**
 * Overlays the confirmed retirements onto the finalized records: a matching
 * symbol gets `removed_in` set (earliest removal wins if another lane already set
 * one), which drops it from snapshots at/after that version. Everything else is
 * returned untouched. Never changes `status` — a removed symbol simply stops
 * appearing; in the snapshots where it IS present it was genuinely live.
 */
export function applyChangelogRemovals<T extends { type: string; symbol: string; removed_in: string | null }>(
  records: readonly T[]
): T[] {
  const byKey = new Map(CONFIRMED_REMOVALS.map((r) => [`${r.type}:${r.symbol}`, r]));
  return records.map((record) => {
    const removal = byKey.get(`${record.type}:${record.symbol}`);
    if (!removal) return record;
    const removed_in =
      record.removed_in !== null && compareVersionsAsc(record.removed_in, removal.removed_in) < 0
        ? record.removed_in
        : removal.removed_in;
    return removed_in === record.removed_in ? record : { ...record, removed_in };
  });
}

/** A removal/deprecation bullet the tight grammar proposes for maintainer review. */
export interface RemovalCandidate {
  version: string;
  verb: 'Removed' | 'Deprecated';
  symbol: string;
  text: string;
}

/**
 * Tight-grammar candidate extractor (the "propose" half of the hybrid). Matches a
 * changelog bullet that BEGINS with Removed/Deprecated and whose first backticked
 * token — optionally after a filler word like "the"/"stale"/"old" — is the
 * object. This rejects the common false positives where the symbol is only
 * referenced later in the sentence ("Removed the startup warning — see `/doctor`").
 * It does not decide truth; a maintainer confirms real retirements into
 * CONFIRMED_REMOVALS. Callers typically filter to symbols the dataset knows and
 * drop already-confirmed ones.
 */
export function extractRemovalCandidates(markdown: string): RemovalCandidate[] {
  const bullet = /^[-*]\s+(Removed|Deprecated)\s+(?:the\s+|stale\s+|old\s+)?`([^`]+)`/;
  const out: RemovalCandidate[] = [];
  let version: string | null = null;
  for (const line of markdown.split('\n')) {
    const header = line.match(/^##\s+([0-9]+\.[0-9]+\.[0-9]+)/);
    if (header) {
      version = header[1] as string;
      continue;
    }
    const match = line.trim().match(bullet);
    if (match && version) {
      out.push({
        version,
        verb: match[1] as RemovalCandidate['verb'],
        symbol: match[2] as string,
        text: line.trim(),
      });
    }
  }
  return out;
}
