// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  applyChangelogDeprecations,
  applyChangelogRemovals,
  CONFIRMED_DEPRECATIONS,
  CONFIRMED_REMOVALS,
  extractRemovalCandidates,
} from './removals.js';

type Rec = { type: string; symbol: string; removed_in: string | null };
const rec = (over: Partial<Rec> = {}): Rec => ({
  type: 'command',
  symbol: '/vim',
  removed_in: null,
  ...over,
});

describe('CONFIRMED_REMOVALS', () => {
  it('every entry is a well-formed, unique retirement', () => {
    const keys = new Set<string>();
    for (const r of CONFIRMED_REMOVALS) {
      expect(r.removed_in).toMatch(/^\d+\.\d+\.\d+$/);
      expect(['cli_flag', 'env_var', 'command', 'config_key', 'internal_config_flag']).toContain(
        r.type
      );
      const key = `${r.type}:${r.symbol}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });
});

describe('applyChangelogRemovals', () => {
  it('sets removed_in on a confirmed retirement', () => {
    const out = applyChangelogRemovals([rec({ symbol: '/vim' })]);
    expect(out[0]?.removed_in).toBe('2.1.92');
  });

  it('matches on type+symbol, not symbol alone', () => {
    // A hypothetical --vim flag is not the /vim command retirement.
    const out = applyChangelogRemovals([rec({ type: 'cli_flag', symbol: '--vim' })]);
    expect(out[0]?.removed_in).toBeNull();
  });

  it('leaves un-retired records untouched (same reference)', () => {
    const input = rec({ symbol: '/keeps' });
    const out = applyChangelogRemovals([input]);
    expect(out[0]).toBe(input);
  });

  it('keeps an already-earlier removed_in (earliest removal wins)', () => {
    const out = applyChangelogRemovals([rec({ symbol: '/vim', removed_in: '2.1.50' })]);
    expect(out[0]?.removed_in).toBe('2.1.50');
  });

  it('overrides a later removed_in with the confirmed earlier one', () => {
    const out = applyChangelogRemovals([rec({ symbol: '/vim', removed_in: '2.1.200' })]);
    expect(out[0]?.removed_in).toBe('2.1.92');
  });
});

type DepRec = { type: string; symbol: string; deprecated_in?: string };
const depRec = (over: Partial<DepRec> = {}): DepRec => ({
  type: 'command',
  symbol: '/output-style',
  ...over,
});

describe('CONFIRMED_DEPRECATIONS', () => {
  it('every entry is a well-formed, unique deprecation', () => {
    const keys = new Set<string>();
    for (const d of CONFIRMED_DEPRECATIONS) {
      expect(d.deprecated_in).toMatch(/^\d+\.\d+\.\d+$/);
      expect(['cli_flag', 'env_var', 'command', 'config_key', 'internal_config_flag']).toContain(
        d.type
      );
      const key = `${d.type}:${d.symbol}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });
});

describe('applyChangelogDeprecations', () => {
  it('sets deprecated_in on a confirmed deprecation', () => {
    const out = applyChangelogDeprecations([depRec({ symbol: '/output-style' })]);
    expect(out[0]?.deprecated_in).toBe('2.1.73');
  });

  it('matches on type+symbol and leaves others untouched', () => {
    const input = depRec({ type: 'cli_flag', symbol: '--output-style' });
    const out = applyChangelogDeprecations([input]);
    expect(out[0]).toBe(input);
    expect(out[0]?.deprecated_in).toBeUndefined();
  });

  it('keeps an already-earlier deprecated_in (earliest wins)', () => {
    const out = applyChangelogDeprecations([depRec({ symbol: '/output-style', deprecated_in: '2.1.50' })]);
    expect(out[0]?.deprecated_in).toBe('2.1.50');
  });
});

const FIXTURE = `# Changelog

## 2.1.92

- Removed \`/vim\` command (toggle vim mode via \`/config\` → Editor mode)
- Removed \`/tag\`

## 2.1.90

- Removed the startup "setup issues" warning — run \`/doctor\` to see it instead
- Fixed \`--json-schema\` so the model can no longer re-call it indefinitely

## 2.1.73

- Deprecated \`/output-style\` in favor of output styles in settings
`;

describe('extractRemovalCandidates', () => {
  const cands = extractRemovalCandidates(FIXTURE);

  it('proposes symbols that are the object of Removed/Deprecated, with the version', () => {
    const byName = new Map(cands.map((c) => [c.symbol, c]));
    expect(byName.get('/vim')).toMatchObject({ version: '2.1.92', verb: 'Removed' });
    expect(byName.get('/tag')).toMatchObject({ version: '2.1.92', verb: 'Removed' });
    expect(byName.get('/output-style')).toMatchObject({ version: '2.1.73', verb: 'Deprecated' });
  });

  it('rejects a symbol merely referenced later in the sentence', () => {
    // "Removed the startup warning — run `/doctor`" must not propose /doctor.
    expect(cands.some((c) => c.symbol === '/doctor')).toBe(false);
  });

  it('rejects a bullet that does not begin with Removed/Deprecated', () => {
    expect(cands.some((c) => c.symbol === '--json-schema')).toBe(false);
  });

  it('reaches the object across bounded connective filler', () => {
    const wide = extractRemovalCandidates(
      [
        '## 2.1.5',
        '- Removed support for `--legacy-flag`',
        '- Removed the deprecated `/old-cmd`',
        '- Deprecated use of `LEGACY_ENV`',
      ].join('\n')
    );
    const names = wide.map((c) => c.symbol);
    expect(names).toContain('--legacy-flag');
    expect(names).toContain('/old-cmd');
    expect(names).toContain('LEGACY_ENV');
  });

  it('still rejects a symbol past a clause break, not the object', () => {
    const wide = extractRemovalCandidates(
      '## 2.1.5\n- Removed the confusing banner — run `/status` to see it\n'
    );
    expect(wide.some((c) => c.symbol === '/status')).toBe(false);
  });
});
