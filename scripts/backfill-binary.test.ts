// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  distillDescriptions,
  distillObservations,
  main,
  type BinaryCacheFile,
} from './backfill-binary.js';

/** A cache file whose symbols carry descriptions. */
function descFile(
  version: string,
  symbols: Array<{
    symbol: string;
    type: BinaryCacheFile['symbols'][number]['type'];
    description?: string;
  }>
): BinaryCacheFile {
  return { version, symbols };
}

describe('distillDescriptions', () => {
  it('collapses consecutive-equal descriptions into change-point eras', () => {
    const files = [
      descFile('0.2.9', [{ symbol: '/review', type: 'command', description: 'Review a PR' }]),
      descFile('1.0.0', [{ symbol: '/review', type: 'command', description: 'Review a PR' }]),
      descFile('2.1.186', [
        { symbol: '/review', type: 'command', description: 'Review a GitHub PR' },
      ]),
    ];
    const { descriptions } = distillDescriptions(files);
    expect(descriptions['command:/review']).toEqual([
      { from: '0.2.9', description: 'Review a PR' },
      { from: '2.1.186', description: 'Review a GitHub PR' },
    ]);
  });

  it('normalizes whitespace so a cosmetic spacing change is not a new era', () => {
    const files = [
      descFile('2.0.2', [
        {
          symbol: '--max-thinking-tokens',
          type: 'cli_flag',
          description: 'Max tokens.  (only --print)',
        },
      ]),
      descFile('2.1.26', [
        {
          symbol: '--max-thinking-tokens',
          type: 'cli_flag',
          description: 'Max tokens. (only --print)',
        },
      ]),
      descFile('2.1.32', [
        {
          symbol: '--max-thinking-tokens',
          type: 'cli_flag',
          description: '  Max tokens. (only --print)  ',
        },
      ]),
    ];
    // Double-space vs single-space vs padded — all collapse to one normalized era.
    expect(distillDescriptions(files).descriptions['cli_flag:--max-thinking-tokens']).toEqual([
      { from: '2.0.2', description: 'Max tokens. (only --print)' },
    ]);
  });

  it('preserves newlines/tabs so structurally-distinct eras stay distinct', () => {
    // Only repeated spaces are cosmetic; a newline/tab is real structure that
    // cleanDescription keeps, so a description that gains one is a genuine new era
    // and its multi-line text must not be flattened.
    const files = [
      descFile('1.0.0', [{ symbol: '/x', type: 'command', description: 'Modes: fast, slow' }]),
      descFile('1.1.0', [{ symbol: '/x', type: 'command', description: 'Modes:\n\tfast\n\tslow' }]),
    ];
    expect(distillDescriptions(files).descriptions['command:/x']).toEqual([
      { from: '1.0.0', description: 'Modes: fast, slow' },
      { from: '1.1.0', description: 'Modes:\n\tfast\n\tslow' },
    ]);
  });

  it('spans a recall gap with the surrounding era (no spurious era on a miss)', () => {
    const files = [
      descFile('1.0.0', [{ symbol: '/x', type: 'command', description: 'A' }]),
      descFile('1.0.1', [{ symbol: '/other', type: 'command', description: 'Z' }]), // /x missing here
      descFile('1.0.2', [{ symbol: '/x', type: 'command', description: 'A' }]),
    ];
    expect(distillDescriptions(files).descriptions['command:/x']).toEqual([
      { from: '1.0.0', description: 'A' },
    ]);
  });

  it('ignores symbols without a description (e.g. flags in this cache)', () => {
    const files = [descFile('1.0.0', [{ symbol: '--flag', type: 'cli_flag' }])];
    expect(distillDescriptions(files).descriptions['cli_flag:--flag']).toBeUndefined();
  });

  it('is a backfill-binary output with sorted keys', () => {
    const files = [
      descFile('1.0.0', [
        { symbol: '/b', type: 'command', description: 'b' },
        { symbol: '/a', type: 'command', description: 'a' },
      ]),
    ];
    const out = distillDescriptions(files);
    expect(out.$generated_by).toBe('scripts/backfill-binary.ts');
    expect(out.source).toBe('binary');
    expect(Object.keys(out.descriptions)).toEqual(['command:/a', 'command:/b']);
  });
});

/** A minimal cache file for a version, listing symbol/type pairs. */
function cacheFile(
  version: string,
  symbols: Array<[string, BinaryCacheFile['symbols'][number]['type']]>
): BinaryCacheFile {
  return { version, symbols: symbols.map(([symbol, type]) => ({ symbol, type })) };
}

describe('distillObservations', () => {
  it('records the earliest and latest version a symbol was observed in', () => {
    const files = [
      cacheFile('1.0.10', [['--print', 'cli_flag']]),
      cacheFile('0.2.9', [['--print', 'cli_flag']]),
      cacheFile('2.1.5', [['--print', 'cli_flag']]),
    ];
    const { symbols } = distillObservations(files);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toEqual({
      symbol: '--print',
      type: 'cli_flag',
      first_seen: '0.2.9',
      last_seen: '2.1.5',
      removed_in: null,
    });
  });

  /** One version's observation of a single flag, with its evidence. */
  const evFile = (version: string, symbol: string, evidence: string): BinaryCacheFile => ({
    version,
    symbols: [{ symbol, type: 'cli_flag', evidence }],
  });

  it('marks a symbol switch_case_only when every version proved it that way', () => {
    const files = [
      evFile('2.1.223', '--health-port', 'argv-switch'),
      evFile('2.1.224', '--health-port', 'argv-switch'),
    ];
    expect(distillObservations(files).symbols[0]).toMatchObject({ switch_case_only: true });
  });

  it('drops the switch_case_only mark as soon as one version has stronger evidence', () => {
    // A flag parsed by a switch in one release and commander-registered in the next
    // is no longer scope-ambiguous, so it must publish normally.
    const files = [
      evFile('2.1.223', '--base-dir', 'argv-switch'),
      evFile('2.1.224', '--base-dir', 'registration'),
    ];
    expect(distillObservations(files).symbols[0]?.switch_case_only).toBeUndefined();
  });

  it("carries a switch-case flag's scopes into the observation", () => {
    const files: BinaryCacheFile[] = [
      {
        version: '2.1.224',
        symbols: [
          {
            symbol: '--min-idle',
            type: 'cli_flag',
            evidence: 'argv-switch',
            scopes: ['self-hosted-runner orchestrator'],
          },
        ],
      },
    ];
    expect(distillObservations(files).symbols[0]).toMatchObject({
      switch_case_only: true,
      scopes: ['self-hosted-runner orchestrator'],
    });
  });

  it('unions scopes across versions and sorts them', () => {
    // A parser may gain a flag in a later release; the observation window is one
    // record, so its scope set is the union over every version that saw it.
    const files: BinaryCacheFile[] = [
      {
        version: '2.1.224',
        symbols: [
          {
            symbol: '--api-url',
            type: 'cli_flag',
            evidence: 'argv-switch',
            scopes: ['self-hosted-runner orchestrator'],
          },
        ],
      },
      {
        version: '2.1.226',
        symbols: [
          {
            symbol: '--api-url',
            type: 'cli_flag',
            evidence: 'argv-switch',
            scopes: ['self-hosted-runner', 'self-hosted-runner decode-token'],
          },
        ],
      },
    ];
    expect(distillObservations(files).symbols[0]?.scopes).toEqual([
      'self-hosted-runner',
      'self-hosted-runner decode-token',
      'self-hosted-runner orchestrator',
    ]);
  });

  it('drops scopes together with the caveat when stronger evidence appears', () => {
    // Scope narrows a flag to a subcommand. Once a version proves the flag by
    // commander registration, keeping the narrowing would assert it is NOT valid
    // on bare `claude` on the strength of an older subcommand parser.
    const files: BinaryCacheFile[] = [
      {
        version: '2.1.224',
        symbols: [
          {
            symbol: '--base-dir',
            type: 'cli_flag',
            evidence: 'argv-switch',
            scopes: ['self-hosted-runner'],
          },
        ],
      },
      {
        version: '2.1.226',
        symbols: [{ symbol: '--base-dir', type: 'cli_flag', evidence: 'registration' }],
      },
    ];
    const [record] = distillObservations(files).symbols;
    expect(record?.switch_case_only).toBeUndefined();
    expect(record?.scopes).toBeUndefined();
  });

  it('omits scopes entirely when no version established one', () => {
    const files = [evFile('2.1.223', '--help', 'argv-switch')];
    expect(distillObservations(files).symbols[0]?.scopes).toBeUndefined();
  });

  it('leaves the mark off symbols found by the ordinary evidence paths', () => {
    const { symbols } = distillObservations([cacheFile('1.0.0', [['--print', 'cli_flag']])]);
    expect(symbols[0]?.switch_case_only).toBeUndefined();
  });

  it('sets removed_in for a clean pre-cliff disappearance', () => {
    // present 1.0.0-1.0.2, then absent across 1.0.3-1.0.5 (all reliable era).
    const files = [
      cacheFile('1.0.0', [['--gone', 'cli_flag']]),
      cacheFile('1.0.1', [['--gone', 'cli_flag']]),
      cacheFile('1.0.2', [['--gone', 'cli_flag']]),
      cacheFile('1.0.3', [['--stays', 'cli_flag']]),
      cacheFile('1.0.4', [['--stays', 'cli_flag']]),
      cacheFile('1.0.5', [['--stays', 'cli_flag']]),
    ];
    const m = new Map(distillObservations(files).symbols.map((s) => [s.symbol, s]));
    expect(m.get('--gone')).toMatchObject({ last_seen: '1.0.2', removed_in: '1.0.3' });
    expect(m.get('--stays')?.removed_in).toBeNull();
  });

  it('compares versions numerically, not lexically (2.1.9 < 2.1.10)', () => {
    const files = [
      cacheFile('2.1.10', [['/compact', 'command']]),
      cacheFile('2.1.9', [['/compact', 'command']]),
    ];
    const [obs] = distillObservations(files).symbols;
    expect(obs?.first_seen).toBe('2.1.9');
    expect(obs?.last_seen).toBe('2.1.10');
  });

  it('keys on type+symbol so a flag and a command of the same name stay distinct', () => {
    const files = [
      cacheFile('1.0.0', [
        ['--compact', 'cli_flag'],
        ['/compact', 'command'],
      ]),
    ];
    const { symbols } = distillObservations(files);
    expect(symbols).toHaveLength(2);
    expect(symbols.map((s) => `${s.type}:${s.symbol}`)).toEqual([
      'cli_flag:--compact',
      'command:/compact',
    ]);
  });

  it('sorts symbols by type then name deterministically', () => {
    const files = [
      cacheFile('1.0.0', [
        ['ZED_TERM', 'env_var'],
        ['--zoom', 'cli_flag'],
        ['/apply', 'command'],
        ['--add-dir', 'cli_flag'],
      ]),
    ];
    const keys = distillObservations(files).symbols.map((s) => `${s.type}:${s.symbol}`);
    expect(keys).toEqual([
      'cli_flag:--add-dir',
      'cli_flag:--zoom',
      'command:/apply',
      'env_var:ZED_TERM',
    ]);
  });

  it('records observedVersions newest-first across every scanned version', () => {
    const files = [
      cacheFile('0.2.9', [['--print', 'cli_flag']]),
      cacheFile('2.1.10', []),
      cacheFile('2.1.9', []),
    ];
    expect(distillObservations(files).observedVersions).toEqual(['2.1.10', '2.1.9', '0.2.9']);
  });

  it('stamps provenance metadata and the removal-caveat note', () => {
    const out = distillObservations([cacheFile('1.0.0', [['--x', 'cli_flag']])]);
    expect(out.$generated_by).toBe('scripts/backfill-binary.ts');
    expect(out.source).toBe('binary');
    expect(out.note).toMatch(/removed_in/);
    expect(out.note).toMatch(/recall regressed/);
  });

  it('ignores cache-only fields (category/evidence/description) — pure evidence out', () => {
    const files: BinaryCacheFile[] = [
      {
        version: '1.0.0',
        source: 'npm',
        count: 1,
        symbols: [
          {
            symbol: 'CLAUDE_CODE_FOO',
            type: 'env_var',
            category: 'claude-code',
            evidence: 'process-env',
            description: 'x',
          },
        ],
      },
    ];
    const [obs] = distillObservations(files).symbols;
    expect(obs).toEqual({
      symbol: 'CLAUDE_CODE_FOO',
      type: 'env_var',
      first_seen: '1.0.0',
      last_seen: '1.0.0',
      removed_in: null,
    });
  });
});

describe('main (arg parsing)', () => {
  it('errors when --cache is passed without a path instead of silently ignoring it', async () => {
    await expect(main(['--cache'])).rejects.toThrow(/--cache requires a path/);
  });

  it('errors when --out is passed without a path', async () => {
    await expect(main(['--out'])).rejects.toThrow(/--out requires a path/);
  });
});

describe('distillObservations — flag visibility eras', () => {
  const v = (version: string, hidden?: true) => ({
    version,
    symbols: [
      {
        symbol: '--teleport',
        type: 'cli_flag' as const,
        evidence: 'registration',
        ...(hidden ? { hidden } : {}),
      },
    ],
  });

  it('records a flag hidden for its whole life as one era', () => {
    expect(
      distillObservations([v('2.1.16', true), v('2.1.20', true)]).symbols[0]?.hidden_eras
    ).toEqual([{ from: '2.1.16', hidden: true }]);
  });

  it('records the version a flag became public', () => {
    // --teleport was hidden through 2.1.220 and public at 2.1.226. Collapsing to
    // the latest state would report `cli` for its entire history.
    const eras = distillObservations([v('2.1.16', true), v('2.1.220', true), v('2.1.226')])
      .symbols[0]?.hidden_eras;
    expect(eras).toEqual([
      { from: '2.1.16', hidden: true },
      { from: '2.1.226', hidden: false },
    ]);
  });

  it('records a flag that was hidden only later', () => {
    const eras = distillObservations([v('2.1.16'), v('2.1.20', true)]).symbols[0]?.hidden_eras;
    // The leading public era is dropped — absence already says "not hidden".
    expect(eras).toEqual([{ from: '2.1.20', hidden: true }]);
  });

  it('omits the field entirely for a flag never hidden', () => {
    expect(distillObservations([v('2.1.16'), v('2.1.20')]).symbols[0]?.hidden_eras).toBeUndefined();
  });

  it('collapses repeats rather than emitting one era per version', () => {
    const eras = distillObservations([
      v('2.1.16', true),
      v('2.1.17', true),
      v('2.1.18', true),
      v('2.1.19'),
      v('2.1.20'),
    ]).symbols[0]?.hidden_eras;
    expect(eras).toEqual([
      { from: '2.1.16', hidden: true },
      { from: '2.1.19', hidden: false },
    ]);
  });
});
