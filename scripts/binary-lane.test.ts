// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  assertBinaryObservations,
  binaryEnvCategory,
  binaryFlagCategory,
  type BinaryObservations,
  computeBinaryRemoval,
  assertBinaryDescriptions,
  type BinaryDescriptions,
  descriptionAt,
  type DescriptionEra,
  isCurrentDescriptionEra,
  isPublishableBinaryEnv,
  isPublishableBinaryFlag,
  mayRedateFromBinary,
  type BinaryObservation,
  loadBinaryDescriptions,
  loadBinaryObservations,
  NEEDS_REVIEW_ENV,
  PROMOTE_CC_ENV,
  PROMOTED_BINARY_SYMBOLS,
  promotionFor,
  RELIABLE_EXTRACTION_CEILING,
} from './binary-lane.js';

function observations(overrides: Partial<BinaryObservations> = {}): BinaryObservations {
  return {
    $generated_by: 'scripts/backfill-binary.ts',
    source: 'binary',
    note: 'x',
    observedVersions: ['1.0.0'],
    symbols: [
      {
        symbol: '--x',
        type: 'cli_flag',
        first_seen: '1.0.0',
        last_seen: '1.0.0',
        removed_in: null,
      },
    ],
    ...overrides,
  };
}

describe('audited env lists', () => {
  // These counts are an inventory check on the human audit (scratch/audit-buckets.md).
  // If you intentionally add/remove a var in binary-lane.ts, update the number here
  // AND record the rationale in the audit doc — a mismatch means the list drifted.
  it('promote-cc holds the 57 audited first-party toggles', () => {
    expect(PROMOTE_CC_ENV.size).toBe(57);
  });

  it('needs-review holds the 35 audited ambiguous vars', () => {
    expect(NEEDS_REVIEW_ENV.size).toBe(35);
  });

  it('the two lists are disjoint', () => {
    const overlap = [...PROMOTE_CC_ENV].filter((s) => NEEDS_REVIEW_ENV.has(s));
    expect(overlap).toEqual([]);
  });
});

describe('audit promotions', () => {
  // Inventory check on the maintainer audit (scratch/needs-review-audit.{md,csv}):
  // 6 commands + 4 agent-team flags with binary-registry descriptions, + 65 flags with `claude --help`
  // descriptions (30 from the original depth-one sweep, 35 from `self-hosted-runner`
  // and its sub-subcommands, 4 more the depth-one sweep had missed). If you
  // promote/demote a symbol, update these counts.
  const entries = [...PROMOTED_BINARY_SYMBOLS.entries()];

  it('holds the 79 audited promotions (10 binary + 69 help)', () => {
    expect(PROMOTED_BINARY_SYMBOLS.size).toBe(79);
    expect(entries.filter(([, p]) => p.description_source === 'binary')).toHaveLength(10);
    expect(entries.filter(([, p]) => p.description_source === 'help')).toHaveLength(69);
  });

  it('leaves the six unresolvable runner flags unpromoted', () => {
    // Not an oversight — each fails the evidence bar for a single description.
    // --api-url/--health-port/--hooks-dir mean different things per invocation and
    // identity is `type:symbol`; --pool-secret-file/--drain-wait-bg-tasks-sec appear
    // only in prose about the flag they alias; --sigkill-timeout-sec is accepted by
    // the parser but absent from help. All six stay needs_review.
    for (const f of [
      '--api-url',
      '--health-port',
      '--hooks-dir',
      '--pool-secret-file',
      '--drain-wait-bg-tasks-sec',
      '--sigkill-timeout-sec',
    ]) {
      expect(PROMOTED_BINARY_SYMBOLS.has(`cli_flag:${f}`), `${f} unexpectedly promoted`).toBe(
        false
      );
    }
  });

  it('keys are well-formed type:symbol and every description is non-empty', () => {
    for (const [key, p] of entries) {
      expect(key).toMatch(/^(command|cli_flag|env_var|config_key|internal_config_flag):.+/);
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('promotionFor resolves a promoted symbol and misses an un-audited one', () => {
    expect(promotionFor('command', '/design')?.description_source).toBe('binary');
    expect(promotionFor('cli_flag', '--cwd')?.description_source).toBe('help');
    expect(promotionFor('cli_flag', '--mcp-debug')).toBeUndefined();
  });
});

describe('isPublishableBinaryEnv', () => {
  it('publishes CLAUDE_/ANTHROPIC_ vars via the claude-code category', () => {
    expect(isPublishableBinaryEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-code')).toBe(true);
  });

  it('publishes an audited promote-cc toggle even when categorized "other"', () => {
    expect(PROMOTE_CC_ENV.has('ENABLE_PLUGINS')).toBe(true);
    expect(isPublishableBinaryEnv('ENABLE_PLUGINS', 'other')).toBe(true);
  });

  it('publishes an audited needs-review var', () => {
    expect(isPublishableBinaryEnv('LOCAL_BRIDGE', 'other')).toBe(true);
  });

  it('leaves an un-audited external var (OS/shell/3rd-party) unpublished', () => {
    expect(isPublishableBinaryEnv('PATH', 'other')).toBe(false);
    expect(isPublishableBinaryEnv('SSH_AUTH_SOCK', 'other')).toBe(false);
    expect(isPublishableBinaryEnv('ALIYUN_REGION_ID', 'cloud')).toBe(false);
  });
});

describe('binaryEnvCategory', () => {
  it('recategorizes a promote-cc var to claude-code', () => {
    expect(binaryEnvCategory('ENABLE_PLUGINS', 'other')).toBe('claude-code');
  });

  it('keeps a needs-review var at its natural category (not recategorized)', () => {
    expect(binaryEnvCategory('LOCAL_BRIDGE', 'other')).toBe('other');
  });

  it('passes through a CLAUDE_-prefixed var already categorized claude-code', () => {
    expect(binaryEnvCategory('CLAUDE_CODE_ENTRYPOINT', 'claude-code')).toBe('claude-code');
  });
});

describe('computeBinaryRemoval', () => {
  // 8 reliable versions, all before the cliff.
  const OBSERVED = ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5', '1.0.6', '1.0.7'];

  it('flags a clean disappearance: solidly present, then absent through reliable versions', () => {
    // present 1.0.0-1.0.3, gone from 1.0.4 on.
    const removed = computeBinaryRemoval(['1.0.0', '1.0.1', '1.0.2', '1.0.3'], OBSERVED);
    expect(removed).toBe('1.0.4');
  });

  it('returns null while the symbol is still present through the latest observed', () => {
    expect(computeBinaryRemoval(OBSERVED, OBSERVED)).toBeNull();
  });

  it('does not flag a low-recall flicker (not solidly present before the gap)', () => {
    // seen only at 1.0.0 and 1.0.3 (isolated hits), then gone — too noisy to trust.
    expect(computeBinaryRemoval(['1.0.0', '1.0.3'], OBSERVED)).toBeNull();
  });

  it('does not flag when too few reliable versions follow the last sighting', () => {
    // last seen 1.0.6 → only 1.0.7 after (< margin of 3).
    expect(computeBinaryRemoval(['1.0.4', '1.0.5', '1.0.6'], OBSERVED)).toBeNull();
  });

  it('never trusts a disappearance in the recall-unreliable (post-cliff) era', () => {
    const observed = [
      '2.1.158',
      '2.1.159',
      RELIABLE_EXTRACTION_CEILING,
      '2.1.161',
      '2.1.162',
      '2.1.163',
    ];
    // solidly present then gone, but the last sighting is AT the cliff ceiling.
    expect(
      computeBinaryRemoval(['2.1.158', '2.1.159', RELIABLE_EXTRACTION_CEILING], observed)
    ).toBeNull();
  });

  it('returns null for a symbol never observed', () => {
    expect(computeBinaryRemoval([], OBSERVED)).toBeNull();
  });
});

describe('assertBinaryObservations', () => {
  it('accepts a well-formed backfill-binary output', () => {
    expect(() => assertBinaryObservations(observations(), 'p')).not.toThrow();
  });

  it('rejects a file not produced by backfill-binary', () => {
    expect(() => assertBinaryObservations(observations({ $generated_by: 'hand' }), 'p')).toThrow(
      /not a scripts\/backfill-binary\.ts output/
    );
    expect(() => assertBinaryObservations(observations({ source: 'docs' }), 'p')).toThrow(
      /not a scripts\/backfill-binary\.ts output/
    );
  });

  it('rejects a valid-but-empty observations file (would silently drop the lane)', () => {
    expect(() => assertBinaryObservations(observations({ symbols: [] }), 'p')).toThrow(/0 symbols/);
  });

  it('rejects a malformed file whose "symbols" is not an array', () => {
    const malformed = { ...observations(), symbols: null } as unknown as BinaryObservations;
    expect(() => assertBinaryObservations(malformed, 'p')).toThrow(/"symbols" is not an array/);
  });
});

describe('loadBinaryObservations', () => {
  it('throws actionable guidance when the committed file is missing', async () => {
    await expect(
      loadBinaryObservations('/tmp/claustodian-no-such-binary-observations.json')
    ).rejects.toThrow(/npm run backfill-binary/);
  });
});

describe('description timeline', () => {
  const eras: DescriptionEra[] = [
    { from: '0.2.9', description: 'old' },
    { from: '2.1.100', description: 'mid' },
    { from: '2.1.186', description: 'current' },
  ];

  it('descriptionAt returns the era active at a version', () => {
    expect(descriptionAt(eras, '0.2.9')?.description).toBe('old');
    expect(descriptionAt(eras, '2.1.99')?.description).toBe('old');
    expect(descriptionAt(eras, '2.1.100')?.description).toBe('mid');
    expect(descriptionAt(eras, '2.1.185')?.description).toBe('mid');
    expect(descriptionAt(eras, '2.1.205')?.description).toBe('current');
  });

  it('descriptionAt returns undefined before the first era', () => {
    expect(descriptionAt(eras, '0.2.1')).toBeUndefined();
  });

  it('isCurrentDescriptionEra is true only at/after the last era', () => {
    expect(isCurrentDescriptionEra(eras, '2.1.185')).toBe(false);
    expect(isCurrentDescriptionEra(eras, '2.1.186')).toBe(true);
    expect(isCurrentDescriptionEra(eras, '2.1.205')).toBe(true);
    expect(isCurrentDescriptionEra([], '2.1.205')).toBe(false);
  });

  it('loadBinaryDescriptions throws actionable guidance when the file is missing', async () => {
    await expect(
      loadBinaryDescriptions('/tmp/claustodian-no-such-binary-descriptions.json')
    ).rejects.toThrow(/npm run backfill-binary/);
  });

  it('assertBinaryDescriptions accepts a backfill output and rejects others', () => {
    const good: BinaryDescriptions = {
      $generated_by: 'scripts/backfill-binary.ts',
      source: 'binary',
      note: '',
      descriptions: { 'command:/x': eras },
    };
    expect(() => assertBinaryDescriptions(good, 'p')).not.toThrow();
    expect(() => assertBinaryDescriptions({ ...good, source: 'hand' }, 'p')).toThrow(
      /not a scripts/
    );
    expect(() =>
      assertBinaryDescriptions(
        { ...good, descriptions: null as unknown as BinaryDescriptions['descriptions'] },
        'p'
      )
    ).toThrow(/malformed/);
  });

  it('assertBinaryDescriptions rejects a malformed timeline (caught here, not in descriptionAt)', () => {
    const base = { $generated_by: 'scripts/backfill-binary.ts', source: 'binary', note: '' };
    const nonArray = {
      ...base,
      descriptions: { 'command:/x': 'oops' as unknown as DescriptionEra[] },
    };
    expect(() => assertBinaryDescriptions(nonArray, 'p')).toThrow(/is not an array of eras/);
    const badEra = {
      ...base,
      descriptions: { 'command:/x': [{ from: '1.0.0' } as unknown as DescriptionEra] },
    };
    expect(() => assertBinaryDescriptions(badEra, 'p')).toThrow(/missing string from\/description/);
  });
});

describe('isPublishableBinaryFlag / mayRedateFromBinary', () => {
  const obs = (extra: Partial<BinaryObservation> = {}): BinaryObservation => ({
    symbol: '--min-idle',
    type: 'cli_flag',
    first_seen: '2.1.224',
    last_seen: '2.1.226',
    removed_in: null,
    ...extra,
  });

  it('publishes a flag proved by an ordinary evidence path', () => {
    expect(isPublishableBinaryFlag(obs())).toBe(true);
  });

  it('withholds a switch-case-only flag with no established scope', () => {
    // Every release before 2.1.224, and `--help`, whose scope cannot be complete.
    expect(isPublishableBinaryFlag(obs({ switch_case_only: true }))).toBe(false);
    expect(isPublishableBinaryFlag(obs({ switch_case_only: true, scopes: [] }))).toBe(false);
  });

  it('publishes a switch-case-only flag once its scope is known', () => {
    const scoped = obs({ switch_case_only: true, scopes: ['self-hosted-runner orchestrator'] });
    expect(isPublishableBinaryFlag(scoped)).toBe(true);
  });

  it('still refuses to re-date an existing record from a scoped observation', () => {
    // The gates diverge here, and that is the point. `--capacity` is ONE record
    // spanning `claude remote-control --capacity` (older, docs) and
    // `claude self-hosted-runner --capacity` (2.1.224). The runner sighting may
    // publish its scope but must not answer "when did --capacity appear?".
    const scoped = obs({
      symbol: '--capacity',
      switch_case_only: true,
      scopes: ['self-hosted-runner'],
    });
    expect(isPublishableBinaryFlag(scoped)).toBe(true);
    expect(mayRedateFromBinary(scoped)).toBe(false);
  });

  it('lets an ordinary observation re-date a record', () => {
    expect(mayRedateFromBinary(obs())).toBe(true);
  });
});

describe('binaryFlagCategory', () => {
  const obs = (extra: Partial<BinaryObservation> = {}): BinaryObservation => ({
    symbol: '--agent-id',
    type: 'cli_flag',
    first_seen: '2.1.16',
    last_seen: '2.1.226',
    removed_in: null,
    ...extra,
  });

  it('marks a hidden flag cli-internal', () => {
    expect(binaryFlagCategory(obs({ hidden: true }), 'cli')).toBe('cli-internal');
  });

  it('leaves a normal flag at the categorizer result', () => {
    expect(binaryFlagCategory(obs(), 'cli')).toBe('cli');
  });

  it('does not change status or existence — hiding is presentation only', () => {
    // `.hideHelp()` says "not for you to type", not "not real": the flag parses
    // and works. Verified against 2.1.226, where every hidden flag is absent
    // from `claude --help` yet accepted on the command line.
    const hidden = obs({ hidden: true });
    expect(isPublishableBinaryFlag(hidden)).toBe(true);
    expect(mayRedateFromBinary(hidden)).toBe(true);
  });
});
