// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  distillControlObservations,
  distillDescriptions,
  distillModElementObservations,
  distillModEventObservations,
  distillModRenderSiteObservations,
  distillModObservations,
  distillObservations,
  loadCacheFiles,
  main,
  type BinaryCacheFile,
} from './backfill-binary.js';
import { CACHE_INCOMPLETE_MARKER } from './reextract-binaries.js';

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

  it('records when a command first seen as an alias got its own name', () => {
    const cmd = (version: string, evidence: string): BinaryCacheFile => ({
      version,
      symbols: [{ symbol: '/restart', type: 'command', evidence }],
    });
    const later = distillObservations([
      cmd('2.1.212', 'command-alias'),
      cmd('2.1.288', 'command-registry'),
    ]).symbols[0];
    expect(later).toMatchObject({ first_seen: '2.1.212', named_first_seen: '2.1.288' });
    const never = distillObservations([cmd('2.1.212', 'command-alias')]).symbols[0];
    expect(never?.named_first_seen).toBeNull();
    const named = distillObservations([cmd('2.1.212', 'command-registry')]).symbols[0];
    expect(named).not.toHaveProperty('named_first_seen');
    // A name that later turns into an alias (`/update` by 2.1.306) dates from the name.
    const demoted = distillObservations([
      cmd('2.1.212', 'command-registry'),
      cmd('2.1.306', 'command-alias'),
    ]).symbols[0];
    expect(demoted).not.toHaveProperty('named_first_seen');
    // Two alias-only versions before the name: the name's version is the answer.
    const twoAliases = distillObservations([
      cmd('2.1.212', 'command-alias'),
      cmd('2.1.250', 'command-alias'),
      cmd('2.1.288', 'command-registry'),
    ]).symbols[0];
    expect(twoAliases?.named_first_seen).toBe('2.1.288');
  });

  it('removes a symbol once the text of every later release proves it gone', () => {
    const file = (version: string, present: boolean, absent: boolean): BinaryCacheFile => ({
      version,
      symbols: present ? [{ symbol: 'CLAUDE_CODE_GONE', type: 'env_var' }] : [],
      textAbsent: absent ? ['env_var:CLAUDE_CODE_GONE'] : [],
    });
    const proven = [
      file('2.1.300', true, false),
      file('2.1.301', false, true),
      file('2.1.302', false, true),
      file('2.1.303', false, true),
    ];
    expect(distillObservations(proven).symbols[0]?.removed_in).toBe('2.1.301');
    // One later release still holds the name as text: the extractor only missed it.
    const missed = [...proven.slice(0, 2), file('2.1.302', false, false), proven[3]!];
    expect(distillObservations(missed).symbols[0]?.removed_in).toBeNull();
  });

  it('needs text proof before the ceiling when a child-env key was the last sighting', () => {
    // Present in two releases, then missing from three, all before 2.1.160: the
    // pre-ceiling rule alone would call that a removal.
    const file = (version: string, evidence?: string, absent = false): BinaryCacheFile => ({
      version,
      symbols: evidence ? [{ symbol: 'CLAUDE_CHILD', type: 'env_var', evidence }] : [],
      textAbsent: absent ? ['env_var:CLAUDE_CHILD'] : [],
    });
    const history = (evidence: string, absent: boolean) => [
      file('2.0.1', evidence),
      file('2.0.2', evidence),
      file('2.0.3', undefined, absent),
      file('2.0.4', undefined, absent),
      file('2.0.5', undefined, absent),
    ];
    const removedIn = (files: BinaryCacheFile[]) =>
      distillObservations(files).symbols[0]?.removed_in;
    expect(removedIn(history('process-env', false))).toBe('2.0.3');
    expect(removedIn(history('child-env', false))).toBeNull();
    expect(removedIn(history('child-env', true))).toBe('2.0.3');
  });

  it('drops a flag no release proves by more than an args-array predicate', () => {
    const file = (version: string, symbol: string, predicateOnly: boolean): BinaryCacheFile => ({
      version,
      symbols: [
        {
          symbol,
          type: 'cli_flag',
          evidence: 'argv',
          ...(predicateOnly ? { predicateOnly: true } : {}),
        },
      ],
    });
    // `--watch` is only ever a shell-check predicate: no record at all.
    expect(
      distillObservations([file('2.1.27', '--watch', true), file('2.1.28', '--watch', true)])
        .symbols
    ).toEqual([]);
    // `--bg` is a predicate first and registered later: kept, and dated from the predicate.
    const bg = distillObservations([file('2.1.119', '--bg', true), file('2.1.187', '--bg', false)])
      .symbols[0];
    expect(bg).toMatchObject({ symbol: '--bg', first_seen: '2.1.119', last_seen: '2.1.187' });
  });

  it('stops the run when a scope ends while the flag keeps other scopes', () => {
    const file = (
      version: string,
      scopes?: string[],
      evidence = 'argv-switch'
    ): BinaryCacheFile => ({
      version,
      symbols: [{ symbol: '--port', type: 'cli_flag', evidence, ...(scopes ? { scopes } : {}) }],
    });
    const lost = [file('2.1.300', ['runner', 'runner orchestrator']), file('2.1.301', ['runner'])];
    expect(() => distillObservations(lost)).toThrow(
      /--port has scope "runner orchestrator" until 2\.1\.300, but 2\.1\.301/
    );
    // A later release that proves no scope at all is not a loss.
    const unproven = [file('2.1.300', ['runner', 'runner orchestrator']), file('2.1.301')];
    expect(() => distillObservations(unproven)).not.toThrow();
    // A scope that comes back, or every scope still present, is not a loss either.
    const steady = [
      file('2.1.300', ['runner']),
      file('2.1.301', ['runner', 'runner orchestrator']),
    ];
    expect(() => distillObservations(steady)).not.toThrow();
    // A flag with strong evidence publishes top-level, so its scopes do not apply.
    const strong = [...lost, file('2.1.302', undefined, 'registration')];
    expect(() => distillObservations(strong)).not.toThrow();
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
            // The 2.1.224 scope stays: a scope that ends stops the run (see below).
            scopes: [
              'self-hosted-runner',
              'self-hosted-runner decode-token',
              'self-hosted-runner orchestrator',
            ],
          },
        ],
      },
    ];
    expect(distillObservations(files).symbols[0]?.scopes).toEqual([
      'self-hosted-runner',
      'self-hosted-runner decode-token',
      'self-hosted-runner orchestrator',
    ]);
    // The union is not one window: the two later scopes keep their own first version.
    expect(distillObservations(files).symbols[0]?.scope_first_seen).toEqual({
      'self-hosted-runner': '2.1.226',
      'self-hosted-runner decode-token': '2.1.226',
    });
  });

  it('omits scope_first_seen when every scope dates from first_seen', () => {
    const files: BinaryCacheFile[] = ['2.1.226', '2.1.224'].map((version) => ({
      version,
      symbols: [
        {
          symbol: '--hooks-dir',
          type: 'cli_flag',
          evidence: 'argv-switch',
          scopes: ['self-hosted-runner'],
        },
      ],
    }));
    const [obs] = distillObservations(files).symbols;
    expect(obs?.scopes).toEqual(['self-hosted-runner']);
    expect(obs).not.toHaveProperty('scope_first_seen');
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
    expect(out.note).toMatch(/raw text of every later release/);
    expect(out.note).toMatch(/extraction absence alone is untrusted/);
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

describe('loadCacheFiles', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('refuses while the cache is marked incomplete', async () => {
    // The guard that matters. A re-extract that refused SOME versions — or that was
    // interrupted after clearing the cache — leaves a POPULATED cache quietly missing
    // them, so the "no files at all" check passes and distilling would publish those
    // absences as removals.
    root = await mkdtemp(join(tmpdir(), 'claustodian-backfill-marker-'));
    await writeFile(join(root, '2.1.0.json'), JSON.stringify({ version: '2.1.0', symbols: [] }));
    await writeFile(join(root, CACHE_INCOMPLETE_MARKER), JSON.stringify({ failures: [] }));

    await expect(loadCacheFiles(root)).rejects.toThrow(/not known to be complete/);
  });

  it('loads normally once the marker is gone', async () => {
    // The other half: the marker must not leave a permanent block behind. (It is not
    // the only refusal in `loadCacheFiles` — an empty cache directory throws too —
    // so this pins the marker path specifically, with a cache file present.)
    root = await mkdtemp(join(tmpdir(), 'claustodian-backfill-ok-'));
    await writeFile(join(root, '2.1.0.json'), JSON.stringify({ version: '2.1.0', symbols: [] }));

    const files = await loadCacheFiles(root);
    expect(files.map((f) => f.version)).toEqual(['2.1.0']);
  });
});

const SCANNED_CACHE_ENTRY = {
  version: '2.1.63',
  symbols: [],
  controlMessages: [
    {
      symbol: 'hook_callback',
      family: 'control_request',
      direction: null,
      description: '',
      evidence: 'schema',
      admittedBy: 'union',
    },
  ],
};

describe('control observations output', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('writes no file at all when no cache entry has been scanned for control messages', async () => {
    // A cache predating the control lane has no `controlMessages` key, which is not
    // the same as one that carries the key and found nothing. `symbols: []` would
    // publish an absence as evidence — a consumer could not tell "the protocol has no
    // subtypes" from "this cache is older than the lane".
    root = await mkdtemp(join(tmpdir(), 'claustodian-control-out-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, '2.1.0.json'), JSON.stringify({ version: '2.1.0', symbols: [] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root, 'binary-observations.json'),
      '--control',
    ]);

    expect(existsSync(join(root, 'control-observations.json'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('carry no control-lane output'));
    // Non-zero because --control was PASSED and could not be honoured. A scripted data
    // PR has no other signal: every gate after this one passes on a control-free dataset.
    expect(exitCode).toBe(1);
    logSpy.mockRestore();
  });

  it('does NOT write the file on a plain backfill, which is what the release bot runs', async () => {
    // The finding this gate exists for. The committed cache is fully scanned, so a
    // scanned-only gate would let the bot create this file on its next dispatch,
    // `scrape` attach the records, and the whole control surface land in an
    // auto-mergeable chore(data) PR — a regeneration arriving from a code change.
    root = await mkdtemp(join(tmpdir(), 'claustodian-control-optin-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, '2.1.63.json'), JSON.stringify(SCANNED_CACHE_ENTRY));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root, 'binary-observations.json'),
    ]);

    expect(existsSync(join(root, 'control-observations.json'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('opt-in'));
    // Zero: this is the release bot's normal path, not a failure.
    expect(exitCode).toBe(0);
    logSpy.mockRestore();
  });

  it('fails loudly when a committed file can no longer be refreshed', async () => {
    // The steady state going wrong. The file is committed, so publishing is on without
    // the flag — and a cache that stopped being fully scanned means the committed
    // observations have silently drifted from it. Exit 0 here would let the bot open a
    // chore(data) PR carrying stale control records with every gate green.
    root = await mkdtemp(join(tmpdir(), 'claustodian-control-drift-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, '2.1.63.json'), JSON.stringify(SCANNED_CACHE_ENTRY));
    await writeFile(join(cache, '2.1.64.json'), JSON.stringify({ version: '2.1.64', symbols: [] }));
    await writeFile(join(root, 'control-observations.json'), '{"symbols":[]}');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root, 'binary-observations.json'),
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('carry no control-lane output'));
    expect(exitCode).toBe(1);
    logSpy.mockRestore();
  });

  it('keeps refreshing the file once it exists, without the flag', async () => {
    // The steady state after the data PR commits it. The workflow re-distils on every
    // run so committed evidence never drifts from the cache; the opt-in must not turn
    // that off, or the file goes stale the moment it is published.
    root = await mkdtemp(join(tmpdir(), 'claustodian-control-steady-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, '2.1.63.json'), JSON.stringify(SCANNED_CACHE_ENTRY));
    await writeFile(join(root, 'control-observations.json'), '{"symbols":[]}');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['--cache', cache, '--out', join(root, 'binary-observations.json')]);

    const written = JSON.parse(
      await readFile(join(root, 'control-observations.json'), 'utf-8')
    ) as { symbols: unknown[] };
    expect(written.symbols).toHaveLength(1);
    logSpy.mockRestore();
  });

  it('refuses a PARTIALLY scanned cache, which would date every subtype from the tip', async () => {
    // The failure this gate exists for. `distillControlObservations` dates a subtype
    // from the entries that carry control output, so one scanned version alongside
    // unscanned ones dates the whole surface to that version — anchored, and wrong.
    // `some` would have accepted this; `every` is what rejects it.
    root = await mkdtemp(join(tmpdir(), 'claustodian-control-partial-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, '2.1.63.json'),
      JSON.stringify({ version: '2.1.63', symbols: [] }) // pre-control-lane: no key
    );
    await writeFile(
      join(cache, '2.1.226.json'),
      JSON.stringify({
        version: '2.1.226',
        symbols: [],
        controlMessages: [
          {
            symbol: 'hook_callback',
            family: 'control_request',
            direction: null,
            description: '',
            evidence: 'schema',
            admittedBy: 'both',
          },
        ],
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root, 'binary-observations.json'),
      '--control',
    ]);

    expect(existsSync(join(root, 'control-observations.json'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('carry no control-lane output'));
    // Non-zero because --control was PASSED and could not be honoured. A scripted data
    // PR has no other signal: every gate after this one passes on a control-free dataset.
    expect(exitCode).toBe(1);
    logSpy.mockRestore();
  });

  it('writes the file once every cache entry carries control-lane output', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-control-out2-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, '2.1.63.json'),
      JSON.stringify({
        version: '2.1.63',
        symbols: [],
        controlMessages: [
          {
            symbol: 'hook_callback',
            family: 'control_request',
            direction: null,
            description: '',
            evidence: 'schema',
            admittedBy: 'union',
          },
        ],
      })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['--cache', cache, '--out', join(root, 'binary-observations.json'), '--control']);

    const written = JSON.parse(
      await readFile(join(root, 'control-observations.json'), 'utf-8')
    ) as { symbols: Array<{ symbol: string; admitted_at_first_seen: string }> };
    expect(written.symbols).toHaveLength(1);
    expect(written.symbols[0]?.admitted_at_first_seen).toBe('union');
    logSpy.mockRestore();
  });
});

describe('distillControlObservations', () => {
  /** A cache file carrying one subtype's per-version state. */
  const file = (
    version: string,
    direction: 'host_to_cli' | 'cli_to_host' | null,
    description: string,
    admittedBy: 'union' | 'dispatch' | 'both'
  ): BinaryCacheFile => ({
    version,
    symbols: [],
    controlMessages: [
      {
        symbol: 'hook_callback',
        family: 'control_request',
        direction,
        description,
        evidence: 'schema',
        admittedBy,
      },
    ],
  });

  it('reads admittedBy at first_seen, not at the newest version', () => {
    // The trap the whole dating policy turns on: a flagged subtype usually starts as
    // `union` and becomes `both` once the CLI dispatches it, so taking the latest value
    // silently un-flags it.
    const [obs] = distillControlObservations([
      file('2.1.63', null, 'Delivers a hook callback.', 'union'),
      file('2.1.226', 'cli_to_host', 'Delivers a hook callback.', 'both'),
    ]);

    expect(obs?.first_seen).toBe('2.1.63');
    expect(obs?.admitted_at_first_seen).toBe('union');
  });

  it('emits an era at the first version even when the value is null', () => {
    // Without a seed era the resolver's fallback would be doing the work silently,
    // and a subtype whose direction is null from the start would have no record of it.
    const [obs] = distillControlObservations([
      file('2.1.63', null, '', 'union'),
      file('2.1.133', 'cli_to_host', '', 'union'),
    ]);

    expect(obs?.direction_eras).toEqual([
      { from: '2.1.63', value: null },
      { from: '2.1.133', value: 'cli_to_host' },
    ]);
  });

  it('records change points only, not one era per version', () => {
    const [obs] = distillControlObservations([
      file('2.1.63', null, 'First.', 'union'),
      file('2.1.64', null, 'First.', 'union'),
      file('2.1.65', null, 'Reworded.', 'union'),
    ]);

    expect(obs?.description_eras).toEqual([
      { from: '2.1.63', value: 'First.' },
      { from: '2.1.65', value: 'Reworded.' },
    ]);
  });

  it('dates a subtype that disappeared, using the same removal rule as the flag lane', () => {
    // `rewind_code` is the real one: present 2.0.43-2.0.62, gone at 2.0.63. The rule is
    // deliberately conservative and this fixture has to satisfy it rather than the
    // other way round — REMOVAL_ABSENCE_MARGIN of 3 absent versions after, and the
    // symbol solidly present in at least two of the three before.
    const absent = (version: string): BinaryCacheFile => ({
      version,
      symbols: [],
      controlMessages: [],
    });
    const [obs] = distillControlObservations([
      file('2.0.43', null, '', 'dispatch'),
      file('2.0.61', null, '', 'dispatch'),
      file('2.0.62', null, '', 'dispatch'),
      absent('2.0.63'),
      absent('2.0.64'),
      absent('2.0.65'),
    ]);

    expect(obs?.last_seen).toBe('2.0.62');
    expect(obs?.removed_in).toBe('2.0.63');
  });

  it('ignores a cache file written before the control lane existed', () => {
    // `controlMessages` is absent in a cache entry predating the control lane; this must
    // not throw. Distilling cannot tell that apart from a scanned version with no
    // subtypes — `main`'s unscanned gate is what refuses the mixed cache, and that has
    // its own tests.
    const obs = distillControlObservations([
      { version: '2.1.63', symbols: [] },
      file('2.1.64', null, '', 'union'),
    ]);

    expect(obs).toHaveLength(1);
    expect(obs[0]?.first_seen).toBe('2.1.64');
  });

  it('carries family from the cache entry rather than hardcoding it', () => {
    // A raw cache file with a synthetic family, cast past the single-literal type, so a
    // regression to a hardcoded value would surface as the wrong label here.
    const raw = (family: string): BinaryCacheFile =>
      ({
        version: '2.1.63',
        symbols: [],
        controlMessages: [
          {
            symbol: 'hook_callback',
            family,
            direction: null,
            description: '',
            evidence: 'schema',
            admittedBy: 'union',
          },
        ],
      }) as unknown as BinaryCacheFile;
    const [obs] = distillControlObservations([raw('some_other_family')]);
    expect(obs?.family).toBe('some_other_family');
  });

  it('throws when a subtype changes family across versions', () => {
    // Family is identity-ish: a subtype that reports two families is a corrupt cache,
    // not a value with an era. Refuse rather than silently pick first_seen's.
    const at = (version: string, family: string): BinaryCacheFile =>
      ({
        version,
        symbols: [],
        controlMessages: [
          {
            symbol: 'hook_callback',
            family,
            direction: null,
            description: '',
            evidence: 'schema',
            admittedBy: 'union',
          },
        ],
      }) as unknown as BinaryCacheFile;
    expect(() =>
      distillControlObservations([at('2.1.63', 'control_request'), at('2.1.64', 'other')])
    ).toThrow(/must not change family/);
  });

  it('returns subtypes sorted by symbol', () => {
    // One subtype per input leaves the sort comparator unexercised; two in reverse
    // order pin that the output is ordered, not insertion-ordered.
    const twoSubtypes = (version: string): BinaryCacheFile => ({
      version,
      symbols: [],
      controlMessages: [
        {
          symbol: 'set_color',
          family: 'control_request',
          direction: null,
          description: '',
          evidence: 'schema',
          admittedBy: 'both',
        },
        {
          symbol: 'add_directory',
          family: 'control_request',
          direction: null,
          description: '',
          evidence: 'schema',
          admittedBy: 'both',
        },
      ],
    });
    const obs = distillControlObservations([twoSubtypes('2.1.63')]);
    expect(obs.map((o) => o.symbol)).toEqual(['add_directory', 'set_color']);
  });
});

/** A fully scanned cache entry carrying only the mod lane's output. */
const modEntry = (
  version: string,
  modMethods: string[],
  modMentions: string[] = []
): BinaryCacheFile => ({
  version,
  symbols: [],
  controlMessages: [],
  modMethods,
  modMentions,
});

describe('distillModObservations', () => {
  it('dates each method from its first and last scanned release', () => {
    const obs = distillModObservations([
      modEntry('2.1.250', ['$.ui.toast', '$.ui.status']),
      modEntry('2.1.242', ['$.ui.toast']),
      modEntry('2.1.260', ['$.ui.toast', '$.ui.status']),
    ]);
    expect(obs).toEqual([
      { symbol: '$.ui.status', first_seen: '2.1.250', last_seen: '2.1.260', removed_in: null },
      { symbol: '$.ui.toast', first_seen: '2.1.242', last_seen: '2.1.260', removed_in: null },
    ]);
  });

  it('removes a method at the first scanned release after its last sighting', () => {
    // The table is read whole, under a floor guard, so absence from it is evidence —
    // unlike the regex lanes, whose recall ceiling keeps their removals below 2.1.160.
    const obs = distillModObservations([
      modEntry('2.1.242', ['$.ui.old', '$.ui.toast']),
      modEntry('2.1.250', ['$.ui.old', '$.ui.toast']),
      modEntry('2.1.260', ['$.ui.toast']),
      modEntry('2.1.270', ['$.ui.toast']),
    ]);
    expect(obs.find((o) => o.symbol === '$.ui.old')).toMatchObject({
      last_seen: '2.1.250',
      removed_in: '2.1.260',
    });
  });

  it('keeps a method live while the bundle still quotes it outside the table', () => {
    // ui.resolve: out of the table at 2.1.267, still quoted (and still documented).
    const obs = distillModObservations([
      modEntry('2.1.242', ['$.ui.resolve', '$.ui.toast']),
      modEntry('2.1.267', ['$.ui.toast'], ['$.ui.resolve']),
      modEntry('2.1.300', ['$.ui.toast'], ['$.ui.resolve']),
    ]);
    expect(obs.find((o) => o.symbol === '$.ui.resolve')).toMatchObject({
      first_seen: '2.1.242',
      removed_in: null,
    });
  });

  it('removes a method only where it leaves both the table and the bundle for good', () => {
    // A synthetic history: out of the table, still quoted for a while, mentioned once
    // more after a gap, then gone for good. Removal waits for the last absence run.
    // `session.turns` keeps the namespace in the table, so absence is observable.
    const obs = distillModObservations([
      modEntry('2.1.242', ['$.session.turnCount', '$.session.turns']),
      modEntry('2.1.268', ['$.session.turns'], ['$.session.turnCount']),
      modEntry('2.1.270', ['$.session.turns'], []),
      modEntry('2.1.280', ['$.session.turns'], ['$.session.turnCount']),
      modEntry('2.1.290', ['$.session.turns'], []),
      modEntry('2.1.300', ['$.session.turns'], []),
    ]);
    expect(obs.find((o) => o.symbol === '$.session.turnCount')).toEqual({
      symbol: '$.session.turnCount',
      first_seen: '2.1.242',
      last_seen: '2.1.242',
      removed_in: '2.1.290',
    });
  });

  it('does not remove a method whose whole namespace left the table', () => {
    // Mentions are scoped to the table's namespaces, so once a namespace has no key
    // left, its methods are unobservable there — not absent.
    const obs = distillModObservations([
      modEntry('2.1.242', ['$.clock.now', '$.ui.toast']),
      modEntry('2.1.250', ['$.ui.toast']),
      modEntry('2.1.260', ['$.ui.toast']),
    ]);
    expect(obs.find((o) => o.symbol === '$.clock.now')?.removed_in).toBeNull();
  });

  it('reads an entry with no mentions key as mentioning nothing', () => {
    const obs = distillModObservations([
      modEntry('2.1.242', ['$.ui.old', '$.ui.toast']),
      { version: '2.1.250', symbols: [], modMethods: ['$.ui.toast'] },
    ]);
    expect(obs.find((o) => o.symbol === '$.ui.old')).toEqual({
      symbol: '$.ui.old',
      first_seen: '2.1.242',
      last_seen: '2.1.242',
      removed_in: '2.1.250',
    });
  });

  it('keeps a method live when it returns after a gap', () => {
    const obs = distillModObservations([
      modEntry('2.1.242', ['$.ui.flaky']),
      modEntry('2.1.250', []),
      modEntry('2.1.260', ['$.ui.flaky']),
    ]);
    expect(obs).toEqual([
      { symbol: '$.ui.flaky', first_seen: '2.1.242', last_seen: '2.1.260', removed_in: null },
    ]);
  });

  it('reads an empty list before the floor as scanned, not as a removal point', () => {
    const obs = distillModObservations([
      modEntry('2.1.241', []),
      modEntry('2.1.242', ['$.ui.toast']),
    ]);
    expect(obs).toEqual([
      { symbol: '$.ui.toast', first_seen: '2.1.242', last_seen: '2.1.242', removed_in: null },
    ]);
  });
});

describe('distillModEventObservations', () => {
  const eventEntry = (version: string, modEvents: string[]): BinaryCacheFile => ({
    version,
    symbols: [],
    modEvents,
  });

  it('dates each event from its first and last scanned release', () => {
    const obs = distillModEventObservations([
      eventEntry('2.1.250', ['tool.call', 'ui.press']),
      eventEntry('2.1.242', ['tool.call']),
      eventEntry('2.1.260', ['tool.call', 'ui.press']),
    ]);
    expect(obs).toEqual([
      { symbol: 'tool.call', first_seen: '2.1.242', last_seen: '2.1.260', removed_in: null },
      { symbol: 'ui.press', first_seen: '2.1.250', last_seen: '2.1.260', removed_in: null },
    ]);
  });

  it('removes an event at the first scanned release after its last sighting', () => {
    // The list is the whole set of events the engine accepts, so leaving it is a removal.
    const obs = distillModEventObservations([
      eventEntry('2.1.242', ['tool.call', 'ui.old']),
      eventEntry('2.1.250', ['tool.call', 'ui.old']),
      eventEntry('2.1.260', ['tool.call']),
      eventEntry('2.1.270', ['tool.call']),
    ]);
    expect(obs.find((o) => o.symbol === 'ui.old')).toEqual({
      symbol: 'ui.old',
      first_seen: '2.1.242',
      last_seen: '2.1.250',
      removed_in: '2.1.260',
    });
  });

  it('keeps an event live when it returns after a gap', () => {
    const obs = distillModEventObservations([
      eventEntry('2.1.242', ['ui.flaky']),
      eventEntry('2.1.250', []),
      eventEntry('2.1.260', ['ui.flaky']),
    ]);
    expect(obs).toEqual([
      { symbol: 'ui.flaky', first_seen: '2.1.242', last_seen: '2.1.260', removed_in: null },
    ]);
  });

  it('skips an entry that was never scanned for events', () => {
    const obs = distillModEventObservations([
      eventEntry('2.1.242', ['tool.call']),
      { version: '2.1.250', symbols: [], modMethods: ['$.ui.toast'] },
    ]);
    expect(obs).toEqual([
      { symbol: 'tool.call', first_seen: '2.1.242', last_seen: '2.1.242', removed_in: null },
    ]);
  });
});

describe('distillModElementObservations', () => {
  const el = (version: string, modElements?: string[]): BinaryCacheFile => ({
    version,
    symbols: [],
    modElements,
  });

  it('dates each element and removes one at the first release after it leaves the lists', () => {
    // div, span and b leave the lists at 2.1.267.
    expect(
      distillModElementObservations([
        el('2.1.242', ['Box', 'div']),
        el('2.1.260', ['Box', 'Button', 'div']),
        el('2.1.267', ['Box', 'Button']),
        el('2.1.270', ['Box', 'Button']),
      ])
    ).toEqual([
      { symbol: 'Box', first_seen: '2.1.242', last_seen: '2.1.270', removed_in: null },
      { symbol: 'Button', first_seen: '2.1.260', last_seen: '2.1.270', removed_in: null },
      { symbol: 'div', first_seen: '2.1.242', last_seen: '2.1.260', removed_in: '2.1.267' },
    ]);
  });

  it('skips an entry never scanned for elements', () => {
    expect(distillModElementObservations([el('2.1.242', ['Box']), el('2.1.250')])).toEqual([
      { symbol: 'Box', first_seen: '2.1.242', last_seen: '2.1.242', removed_in: null },
    ]);
  });

  it('refuses --mod-elements while a cache entry predates the element lane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claustodian-el-out-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, '2.1.242.json'), JSON.stringify(el('2.1.242', ['Box'])));
    await writeFile(join(cache, '2.1.250.json'), JSON.stringify(el('2.1.250')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(root, 'binary-observations.json');
    expect(await main(['--cache', cache, '--out', out])).toBe(0);
    expect(await main(['--cache', cache, '--out', out, '--mod-elements'])).toBe(1);
    expect(existsSync(join(root, 'mod-element-observations.json'))).toBe(false);
    await rm(join(cache, '2.1.250.json'));
    expect(await main(['--cache', cache, '--out', out, '--mod-elements'])).toBe(0);
    expect(existsSync(join(root, 'mod-element-observations.json'))).toBe(true);
    logSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });
});

describe('distillModRenderSiteObservations', () => {
  const siteEntry = (version: string, sites: string[], listed: boolean): BinaryCacheFile => ({
    version,
    symbols: [],
    modRenderSites: sites,
    modRenderSitesListed: listed,
  });

  it('dates each site from its first and last proving release', () => {
    expect(
      distillModRenderSiteObservations([
        siteEntry('2.1.250', ['Spinner', 'ToolUse'], false),
        siteEntry('2.1.242', ['Spinner'], false),
        siteEntry('2.1.290', ['Spinner', 'ToolUse'], true),
      ])
    ).toEqual([
      { symbol: 'Spinner', first_seen: '2.1.242', last_seen: '2.1.290', removed_in: null },
      { symbol: 'ToolUse', first_seen: '2.1.250', last_seen: '2.1.290', removed_in: null },
    ]);
  });

  it('removes nothing on absence from the calls alone, before the enum ships', () => {
    // AbovePrompt and Pane leave the useRenderInput calls at 2.1.269. With no
    // listed release after that, the absence must not become a removal.
    const obs = distillModRenderSiteObservations([
      siteEntry('2.1.265', ['Pane', 'Spinner'], false),
      siteEntry('2.1.269', ['Spinner'], false),
      siteEntry('2.1.280', ['Spinner'], false),
    ]);
    expect(obs.find((o) => o.symbol === 'Pane')).toMatchObject({
      last_seen: '2.1.265',
      removed_in: null,
    });
  });

  it('removes a site at the first listed release after its last sighting', () => {
    const obs = distillModRenderSiteObservations([
      siteEntry('2.1.265', ['Old', 'Spinner'], false),
      siteEntry('2.1.270', ['Spinner'], false),
      siteEntry('2.1.285', ['Spinner'], true),
      siteEntry('2.1.290', ['Spinner'], true),
    ]);
    expect(obs.find((o) => o.symbol === 'Old')).toEqual({
      symbol: 'Old',
      first_seen: '2.1.265',
      last_seen: '2.1.265',
      removed_in: '2.1.285',
    });
  });

  it('refuses --mod-render-sites while a cache entry predates the site lane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claustodian-site-out-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, '2.1.242.json'),
      JSON.stringify(siteEntry('2.1.242', ['Spinner'], false))
    );
    await writeFile(
      join(cache, '2.1.250.json'),
      JSON.stringify({ version: '2.1.250', symbols: [] })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = join(root, 'binary-observations.json');
    expect(await main(['--cache', cache, '--out', out])).toBe(0);
    expect(await main(['--cache', cache, '--out', out, '--mod-render-sites'])).toBe(1);
    expect(existsSync(join(root, 'mod-render-site-observations.json'))).toBe(false);
    await rm(join(cache, '2.1.250.json'));
    expect(await main(['--cache', cache, '--out', out, '--mod-render-sites'])).toBe(0);
    expect(existsSync(join(root, 'mod-render-site-observations.json'))).toBe(true);
    logSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });
});

describe('mod event observations output', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function cacheWith(entries: BinaryCacheFile[]): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'claustodian-mod-event-out-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    for (const entry of entries) {
      await writeFile(join(cache, `${entry.version}.json`), JSON.stringify(entry));
    }
    return cache;
  }
  const run = (cache: string, ...flags: string[]) =>
    main(['--cache', cache, '--out', join(root!, 'binary-observations.json'), ...flags]);

  it('writes the file on --mod-events, independent of --mods', async () => {
    const cache = await cacheWith([
      { version: '2.1.242', symbols: [], modMethods: ['$.ui.toast'], modEvents: ['tool.call'] },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await run(cache, '--mod-events')).toBe(0);
    expect(existsSync(join(root!, 'mod-observations.json'))).toBe(false);
    const written = JSON.parse(await readFile(join(root!, 'mod-event-observations.json'), 'utf-8'));
    expect(written).toMatchObject({
      observedVersions: ['2.1.242'],
      symbols: [
        { symbol: 'tool.call', first_seen: '2.1.242', last_seen: '2.1.242', removed_in: null },
      ],
    });
    logSpy.mockRestore();
  });

  it('does NOT write the file on a plain backfill, which is what the release bot runs', async () => {
    const cache = await cacheWith([{ version: '2.1.242', symbols: [], modEvents: ['tool.call'] }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await run(cache)).toBe(0);
    expect(existsSync(join(root!, 'mod-event-observations.json'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--mod-events'));
    logSpy.mockRestore();
  });

  it('refuses --mod-events when a cache entry predates the event lane', async () => {
    // Every committed cache entry written before this lane has modMethods but no
    // modEvents, so --mods alone must still pass while --mod-events refuses.
    const cache = await cacheWith([
      { version: '2.1.242', symbols: [], modMethods: ['$.ui.toast'], modEvents: ['tool.call'] },
      { version: '2.1.250', symbols: [], modMethods: ['$.ui.toast'] },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await run(cache, '--mods')).toBe(0);
    expect(await run(cache, '--mod-events')).toBe(1);
    expect(existsSync(join(root!, 'mod-event-observations.json'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('carry no mod-lane event output'));
    logSpy.mockRestore();
  });
});

describe('mod observations output', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function cacheWith(entries: BinaryCacheFile[]): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'claustodian-mod-out-'));
    const cache = join(root, 'cache');
    await mkdir(cache, { recursive: true });
    for (const entry of entries) {
      await writeFile(join(cache, `${entry.version}.json`), JSON.stringify(entry));
    }
    return cache;
  }

  it('writes the file on --mods, independent of the control opt-in', async () => {
    const cache = await cacheWith([modEntry('2.1.242', ['$.ui.toast'])]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root!, 'binary-observations.json'),
      '--mods',
    ]);

    expect(exitCode).toBe(0);
    expect(existsSync(join(root!, 'control-observations.json'))).toBe(false);
    const written = JSON.parse(await readFile(join(root!, 'mod-observations.json'), 'utf-8'));
    expect(written).toMatchObject({
      $generated_by: 'scripts/backfill-binary.ts',
      source: 'binary',
      observedVersions: ['2.1.242'],
      symbols: [
        { symbol: '$.ui.toast', first_seen: '2.1.242', last_seen: '2.1.242', removed_in: null },
      ],
    });
    logSpy.mockRestore();
  });

  it('does NOT write the file on a plain backfill, which is what the release bot runs', async () => {
    const cache = await cacheWith([modEntry('2.1.242', ['$.ui.toast'])]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root!, 'binary-observations.json'),
    ]);

    expect(existsSync(join(root!, 'mod-observations.json'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--mods'));
    expect(exitCode).toBe(0);
    logSpy.mockRestore();
  });

  it('refuses --mods and writes nothing when any cache entry was never scanned', async () => {
    const cache = await cacheWith([
      modEntry('2.1.242', ['$.ui.toast']),
      { version: '2.1.250', symbols: [], controlMessages: [] },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root!, 'binary-observations.json'),
      '--mods',
    ]);

    expect(existsSync(join(root!, 'mod-observations.json'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('carry no mod-lane output'));
    expect(exitCode).toBe(1);
    logSpy.mockRestore();
  });

  it('still writes the mod file when the control lane skips', async () => {
    // The two gates are independent: a control refusal must not starve the mod lane.
    const cache = await cacheWith([
      { version: '2.1.242', symbols: [], modMethods: ['$.ui.toast'] },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main([
      '--cache',
      cache,
      '--out',
      join(root!, 'binary-observations.json'),
      '--mods',
      '--control',
    ]);

    expect(existsSync(join(root!, 'mod-observations.json'))).toBe(true);
    expect(existsSync(join(root!, 'control-observations.json'))).toBe(false);
    expect(exitCode).toBe(1);
    logSpy.mockRestore();
  });
});
