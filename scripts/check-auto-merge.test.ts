// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { evaluateAutoMerge } from './check-auto-merge.js';
import type { SymbolRecord } from './scrape-changelog.js';

function makeSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    symbol: '--safe-mode',
    type: 'cli_flag',
    first_seen: '2.1.201',
    removed_in: null,
    status: 'active',
    provenance: 'binary',
    confidence: 'high',
    description: 'Enables safe mode.',
    source_url: null,
    category: 'startup',
    ...overrides,
  };
}

describe('evaluateAutoMerge', () => {
  it('clears a clean incremental add (a new flag, nothing else moved)', () => {
    const prev = { symbols: [makeSymbol({ symbol: '--foo' })] };
    const next = {
      symbols: [makeSymbol({ symbol: '--foo' }), makeSymbol({ symbol: '--bar' })],
    };

    const verdict = evaluateAutoMerge(prev, next);
    expect(verdict.safe).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict).toMatchObject({ added: 1, removed: 0, changed: 0, prevTotal: 1, nextTotal: 2 });
  });

  it('clears an identical snapshot (a release that adds no new symbols)', () => {
    const symbols = [makeSymbol({ symbol: '--foo' })];
    const verdict = evaluateAutoMerge({ symbols }, { symbols: [...symbols] });
    expect(verdict.safe).toBe(true);
  });

  it('withholds when a symbol is removed from the snapshot', () => {
    const prev = {
      symbols: [makeSymbol({ symbol: '--foo' }), makeSymbol({ symbol: '--gone' })],
    };
    const next = { symbols: [makeSymbol({ symbol: '--foo' })] };

    const verdict = evaluateAutoMerge(prev, next);
    expect(verdict.safe).toBe(false);
    expect(verdict.reasons[0]).toContain('removed from the snapshot');
    expect(verdict.reasons[0]).toContain('cli_flag:--gone');
  });

  it('withholds when a type count drops even though the total holds', () => {
    // One cli_flag disappears, one env_var appears: total is unchanged, but the
    // cli_flag lane shrank — the exact "total holds, a lane gutted" case.
    const prev = {
      symbols: [makeSymbol({ symbol: '--foo' }), makeSymbol({ symbol: '--bar' })],
    };
    const next = {
      symbols: [
        makeSymbol({ symbol: '--foo' }),
        makeSymbol({ symbol: 'NEW_VAR', type: 'env_var' }),
      ],
    };

    const verdict = evaluateAutoMerge(prev, next);
    expect(verdict.safe).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('type "cli_flag" dropped 2 -> 1'))).toBe(true);
  });

  it('withholds when a provenance count drops', () => {
    // Same total and same types, but a docs-provenance record flips to binary:
    // the docs lane quietly stopped contributing.
    const prev = {
      symbols: [
        makeSymbol({ symbol: '--foo', provenance: 'docs' }),
        makeSymbol({ symbol: '--bar', provenance: 'binary' }),
      ],
    };
    const next = {
      symbols: [
        makeSymbol({ symbol: '--foo', provenance: 'binary' }),
        makeSymbol({ symbol: '--bar', provenance: 'binary' }),
      ],
    };

    const verdict = evaluateAutoMerge(prev, next);
    expect(verdict.safe).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('provenance "docs" dropped 1 -> 0'))).toBe(true);
  });

  it('withholds when an existing symbol is re-dated', () => {
    const prev = { symbols: [makeSymbol({ symbol: '--foo', first_seen: '2.1.100' })] };
    const next = { symbols: [makeSymbol({ symbol: '--foo', first_seen: '2.1.090' })] };

    const verdict = evaluateAutoMerge(prev, next);
    expect(verdict.safe).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('first_seen re-dated'))).toBe(true);
    expect(verdict.reasons.some((r) => r.includes('2.1.100 -> 2.1.090'))).toBe(true);
  });

  it('caps the removed-symbol sample so a gutted lane does not flood the log', () => {
    // 20 flags on the base, all gone: the reason names a sample of 15 and then
    // "(+5 more)", while the count stays the full 20.
    const prev = {
      symbols: Array.from({ length: 20 }, (_, i) => makeSymbol({ symbol: `--flag-${i}` })),
    };
    const next = { symbols: [] as SymbolRecord[] };

    const verdict = evaluateAutoMerge(prev, next);
    expect(verdict.safe).toBe(false);
    const removalReason = verdict.reasons.find((r) => r.includes('removed from the snapshot'));
    expect(removalReason).toContain('20 symbol(s) removed');
    expect(removalReason).toContain('(+5 more)');
  });

  it('clears a benign change to an existing symbol (description enriched by docs)', () => {
    // A docs refresh runs every bot run; a changed description must NOT withhold.
    const prev = { symbols: [makeSymbol({ symbol: '--foo', description: 'old' })] };
    const next = { symbols: [makeSymbol({ symbol: '--foo', description: 'enriched' })] };

    const verdict = evaluateAutoMerge(prev, next);
    expect(verdict.safe).toBe(true);
    expect(verdict.changed).toBe(1);
  });
});
