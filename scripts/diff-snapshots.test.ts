import { describe, expect, it } from 'vitest';

import { diffSnapshots } from './diff-snapshots.js';
import type { SymbolRecord } from './scrape-changelog.js';

/**
 * A well-formed symbol record. Individual tests clone this via
 * `makeSymbol({...overrides})` and override just the field(s) under test.
 */
function makeSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    symbol: '--safe-mode',
    type: 'cli_flag',
    first_seen: '2.1.201',
    removed_in: null,
    status: 'active',
    provenance: 'changelog',
    confidence: 'high',
    description: 'Enables safe mode.',
    source_url: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
    category: 'startup',
    ...overrides,
  };
}

describe('diffSnapshots', () => {
  it('reports no added/removed/changed for identical snapshots', () => {
    const symbols = [
      makeSymbol({ symbol: '--foo' }),
      makeSymbol({ symbol: 'BAR_BAZ', type: 'env_var' }),
    ];
    const diff = diffSnapshots({ symbols }, { symbols: [...symbols] });
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });

  it('detects added-only symbols', () => {
    const prev = { symbols: [makeSymbol({ symbol: '--foo' })] };
    const next = {
      symbols: [makeSymbol({ symbol: '--foo' }), makeSymbol({ symbol: '--bar' })],
    };

    const diff = diffSnapshots(prev, next);
    expect(diff.added.map((s) => s.symbol)).toEqual(['--bar']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('detects removed-only symbols', () => {
    const prev = {
      symbols: [makeSymbol({ symbol: '--foo' }), makeSymbol({ symbol: '--bar' })],
    };
    const next = { symbols: [makeSymbol({ symbol: '--foo' })] };

    const diff = diffSnapshots(prev, next);
    expect(diff.removed.map((s) => s.symbol)).toEqual(['--bar']);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('detects a changed field on a symbol present in both, keeping before/after', () => {
    const prev = {
      symbols: [makeSymbol({ symbol: '--foo', status: 'active' })],
    };
    const next = {
      symbols: [makeSymbol({ symbol: '--foo', status: 'deprecated' })],
    };

    const diff = diffSnapshots(prev, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.key).toBe('cli_flag:--foo');
    expect(diff.changed[0]?.before.status).toBe('active');
    expect(diff.changed[0]?.after.status).toBe('deprecated');
  });

  it('does not confuse two different types sharing the same symbol name', () => {
    // `--foo` as a cli_flag vs `--foo` (hypothetically) as some other type
    // would be different keys; here we confirm two distinct types with the
    // same literal string in `symbol` are tracked independently.
    const prev = {
      symbols: [makeSymbol({ symbol: 'FOO', type: 'env_var', status: 'active' })],
    };
    const next = {
      symbols: [
        makeSymbol({ symbol: 'FOO', type: 'env_var', status: 'active' }),
        makeSymbol({ symbol: 'FOO', type: 'cli_flag' }),
      ],
    };

    const diff = diffSnapshots(prev, next);
    expect(diff.added.map((s) => `${s.type}:${s.symbol}`)).toEqual(['cli_flag:FOO']);
    expect(diff.changed).toEqual([]);
  });

  it('sorts added/removed/changed deterministically by key regardless of input order', () => {
    const prev = {
      symbols: [
        makeSymbol({ symbol: '--zeta', status: 'active' }),
        makeSymbol({ symbol: '--alpha', status: 'active' }),
      ],
    };
    const next = {
      symbols: [
        makeSymbol({ symbol: '--zeta', status: 'deprecated' }),
        makeSymbol({ symbol: '--alpha', status: 'deprecated' }),
        makeSymbol({ symbol: '--mu' }),
        makeSymbol({ symbol: '--beta' }),
      ],
    };

    const diff = diffSnapshots(prev, next);
    expect(diff.added.map((s) => s.symbol)).toEqual(['--beta', '--mu']);
    expect(diff.changed.map((c) => c.key)).toEqual(['cli_flag:--alpha', 'cli_flag:--zeta']);
  });
});
