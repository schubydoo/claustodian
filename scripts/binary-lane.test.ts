// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { controlMessageConfidence, type ControlEvidence } from './control-lane.js';
import {
  assertBinaryObservations,
  assertControlObservations,
  type ControlObservationsFile,
  binaryEnvCategory,
  binaryFlagCategory,
  hiddenAt,
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
  // 6 commands + 33 hidden (cli-internal) flags with binary-registry descriptions, + 65 flags with `claude --help`
  // descriptions (30 from the original depth-one sweep, 35 from `self-hosted-runner`
  // and its sub-subcommands, 4 more the depth-one sweep had missed). If you
  // promote/demote a symbol, update these counts.
  const entries = [...PROMOTED_BINARY_SYMBOLS.entries()];

  it('holds the 111 audited promotions (39 binary + 72 help)', () => {
    expect(PROMOTED_BINARY_SYMBOLS.size).toBe(111);
    expect(entries.filter(([, p]) => p.description_source === 'binary')).toHaveLength(39);
    expect(entries.filter(([, p]) => p.description_source === 'help')).toHaveLength(72);
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

describe('assertControlObservations', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    symbol: 'hook_callback',
    family: 'control_request',
    first_seen: '2.1.63',
    last_seen: '2.1.226',
    removed_in: null,
    direction_eras: [{ from: '2.1.63', value: null }],
    description_eras: [{ from: '2.1.63', value: '' }],
    evidence_eras: [{ from: '2.1.63', value: 'schema' }],
    admitted_at_first_seen: 'both',
    ...over,
  });
  const envelope = (over: Record<string, unknown> = {}): ControlObservationsFile =>
    ({
      $generated_by: 'scripts/backfill-binary.ts',
      source: 'binary',
      symbols: [entry()],
      ...over,
    }) as ControlObservationsFile;

  it('accepts a backfill output', () => {
    expect(() => assertControlObservations(envelope(), 'p')).not.toThrow();
  });

  it('refuses a file that is not a backfill output', () => {
    // The point of the guard: `controlRecordsFor` stamps every record
    // `provenance: "binary"`, so a hand-edited file would publish dates no extraction
    // produced. `npm run validate` routes this file to no schema, so nothing else asks.
    expect(() => assertControlObservations(envelope({ $generated_by: 'hand' }), 'p')).toThrow(
      /not a scripts\/backfill-binary\.ts output/
    );
    expect(() => assertControlObservations(envelope({ source: 'docs' }), 'p')).toThrow(
      /not a scripts\/backfill-binary\.ts output/
    );
  });

  it.each(['direction_eras', 'description_eras', 'evidence_eras'] as const)(
    'names the entry and the field when %s is missing',
    (field) => {
      // Without this, a truncated entry reaches eraValueAt and dies on a bare
      // "eras is not iterable" mid-scrape, naming neither the file nor the subtype.
      // Each field is checked so the loop's throw fires past its first iteration too.
      const broken = envelope({ symbols: [entry({ [field]: undefined })] });
      expect(() => assertControlObservations(broken, 'p')).toThrow(/hook_callback/);
      expect(() => assertControlObservations(broken, 'p')).toThrow(new RegExp(field));
    }
  );

  it('accepts an empty symbol list, which the caller refuses separately', () => {
    // Emptiness is the regression guard's business (controlRegressionRefusal), not
    // this one's — an empty file is well-formed, it just must not silently publish.
    expect(() => assertControlObservations(envelope({ symbols: [] }), 'p')).not.toThrow();
  });

  it('names the entry when admitted_at_first_seen is missing', () => {
    // The one field whose absence un-flags an upper bound silently, so the guard must
    // catch it as loudly as the era arrays.
    const broken = envelope({ symbols: [entry({ admitted_at_first_seen: undefined })] });
    expect(() => assertControlObservations(broken, 'p')).toThrow(/hook_callback/);
    expect(() => assertControlObservations(broken, 'p')).toThrow(/admitted_at_first_seen/);
  });

  it('tolerates an absent symbol list on a provenance-valid envelope', () => {
    // The loader guards `Array.isArray(symbols)` before calling this, so the `?? []`
    // is purely defensive for a direct caller — exercise it so it cannot rot.
    expect(() => assertControlObservations(envelope({ symbols: undefined }), 'p')).not.toThrow();
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

  const HIDDEN = [{ from: '2.1.16', hidden: true }];

  it('marks a hidden flag cli-internal', () => {
    expect(binaryFlagCategory(HIDDEN, '2.1.226', 'cli')).toBe('cli-internal');
  });

  it('leaves a normal flag at the categorizer result', () => {
    expect(binaryFlagCategory(undefined, '2.1.226', 'cli')).toBe('cli');
  });

  it('resolves visibility PER VERSION, not from the latest state', () => {
    // Real transitions: --teleport is hidden through 2.1.220 and public at
    // 2.1.226; --task-budget flips at 2.1.220. Reporting one value for the whole
    // history would tell a 2.1.100 consumer today's answer.
    const eras = [
      { from: '2.0.31', hidden: true },
      { from: '2.1.226', hidden: false },
    ];
    expect(binaryFlagCategory(eras, '2.1.100', 'cli')).toBe('cli-internal');
    expect(binaryFlagCategory(eras, '2.1.220', 'cli')).toBe('cli-internal');
    expect(binaryFlagCategory(eras, '2.1.226', 'cli')).toBe('cli');
  });

  it('reports not-hidden before the first era', () => {
    // No observation of hiding that early is not evidence that it was hidden.
    expect(hiddenAt(HIDDEN, '2.1.15')).toBe(false);
    expect(hiddenAt(HIDDEN, '2.1.16')).toBe(true);
  });

  it('does not change status or existence — hiding is presentation only', () => {
    // `.hideHelp()` says "not for you to type", not "not real": the flag parses
    // and works. Verified against 2.1.226, where every hidden flag is absent
    // from `claude --help` yet accepted on the command line.
    const hidden = obs({ hidden_eras: HIDDEN });
    expect(isPublishableBinaryFlag(hidden)).toBe(true);
    expect(mayRedateFromBinary(hidden)).toBe(true);
  });
});

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  controlRecordDating,
  eraValueAt,
  loadControlObservations,
  type ControlObservation,
} from './binary-lane.js';

describe('control record dating', () => {
  const obs = (
    admitted: ControlObservation['admitted_at_first_seen'],
    evidence: 'schema' | 'call_site' | 'dispatch',
    description: string
  ): ControlObservation => ({
    symbol: 'hook_callback',
    family: 'control_request',
    first_seen: '2.1.63',
    last_seen: '2.1.226',
    removed_in: null,
    direction_eras: [{ from: '2.1.63', value: null }],
    description_eras: [{ from: '2.1.63', value: description }],
    evidence_eras: [{ from: '2.1.63', value: evidence }],
    admitted_at_first_seen: admitted,
  });

  it('caps a union-only admission at medium even with the strongest evidence', () => {
    // The case the whole policy exists for. On evidence alone this grades `high`; its
    // date is an upper bound, and the contract forbids `high` with estimated set, so
    // the record would FAIL VALIDATION if evidence were allowed to win.
    expect(
      controlRecordDating(obs('union', 'schema', 'Delivers a hook callback.'), '2.1.226')
    ).toEqual({ first_seen_estimated: true, confidence: 'medium' });
  });

  it('leaves a dispatched admission ungraded down', () => {
    expect(
      controlRecordDating(obs('both', 'schema', 'Delivers a hook callback.'), '2.1.226')
    ).toEqual({ first_seen_estimated: false, confidence: 'high' });
  });

  it('does not raise weak evidence just because the date is sound', () => {
    // Dating certainty only ever LOWERS the grade; it cannot promote a bare dispatch.
    expect(controlRecordDating(obs('dispatch', 'dispatch', ''), '2.1.226')).toEqual({
      first_seen_estimated: false,
      confidence: 'low',
    });
  });

  it('grades a described schema by the description in force at THAT version', () => {
    // Descriptions do not exist before 2.1.63 and can be reworded after, so grading by
    // the latest one would stamp today's answer on an older snapshot.
    const o: ControlObservation = {
      ...obs('both', 'schema', ''),
      description_eras: [
        { from: '2.1.63', value: '' },
        { from: '2.1.100', value: 'Delivers a hook callback.' },
      ],
    };
    expect(controlRecordDating(o, '2.1.63').confidence).toBe('medium');
    expect(controlRecordDating(o, '2.1.100').confidence).toBe('high');
  });
});

describe('eraValueAt', () => {
  it('returns the fallback before the first era, then each era in force', () => {
    const eras = [
      { from: '2.1.63', value: 'a' },
      { from: '2.1.133', value: 'b' },
    ];
    expect(eraValueAt(eras, '2.1.0', 'seed')).toBe('seed');
    expect(eraValueAt(eras, '2.1.63', 'seed')).toBe('a');
    expect(eraValueAt(eras, '2.1.132', 'seed')).toBe('a');
    expect(eraValueAt(eras, '2.1.226', 'seed')).toBe('b');
  });
});

describe('loadControlObservations', () => {
  it('reports absence rather than throwing, because absence is legitimate once', async () => {
    // Before the first re-extract with the control lane, backfill-binary writes no
    // file. The CALLER decides whether that is acceptable, by checking the prior
    // dataset — this only reports which case it is.
    const result = await loadControlObservations('/tmp/claustodian-no-such-control.json');
    expect(result).toMatchObject({ observations: [], present: false });
  });

  it('refuses a malformed file rather than reading it as no control messages', async () => {
    const path = join(tmpdir(), `claustodian-bad-control-${process.pid}.json`);
    await writeFile(path, JSON.stringify({ note: 'no symbols array here' }));
    await expect(loadControlObservations(path)).rejects.toThrow(/Refusing to treat a malformed/);
    await rm(path, { force: true });
  });

  it('reports absence only for a MISSING file, not for any read error', async () => {
    // A directory at the path fails readFile with EISDIR, not ENOENT — a real failure
    // that must throw rather than be read as "no control records", which downstream
    // would ship as a mass removal.
    const dir = join(tmpdir(), `claustodian-control-dir-${process.pid}`);
    await mkdir(dir, { recursive: true });
    await expect(loadControlObservations(dir)).rejects.toThrow(/Cannot read control observations/);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a syntactically broken file rather than reading it as an absence', async () => {
    // Distinct from the missing-`symbols` case above: this dies in JSON.parse, and the
    // guard turns a bare SyntaxError into an actionable message naming the file.
    const path = join(tmpdir(), `claustodian-torn-control-${process.pid}.json`);
    await writeFile(path, '{ "symbols": [ '); // truncated mid-write
    await expect(loadControlObservations(path)).rejects.toThrow(/is not valid JSON/);
    await rm(path, { force: true });
  });

  it('reads a backfill output', async () => {
    const path = join(tmpdir(), `claustodian-good-control-${process.pid}.json`);
    await writeFile(
      path,
      JSON.stringify({
        $generated_by: 'scripts/backfill-binary.ts',
        source: 'binary',
        symbols: [
          {
            symbol: 'hook_callback',
            family: 'control_request',
            first_seen: '2.1.63',
            last_seen: '2.1.226',
            removed_in: null,
            direction_eras: [{ from: '2.1.63', value: null }],
            description_eras: [{ from: '2.1.63', value: '' }],
            evidence_eras: [{ from: '2.1.63', value: 'schema' }],
            admitted_at_first_seen: 'both',
          },
        ],
      })
    );
    const result = await loadControlObservations(path);
    expect(result.present).toBe(true);
    expect(result.observations).toHaveLength(1);
    await rm(path, { force: true });
  });

  it('refuses a hand-edited file, which would publish dates no extraction produced', async () => {
    // The integrity check runs INSIDE the loader, so it cannot be left off at a call
    // site. `npm run validate` routes this file to no schema, so nothing else asks.
    const path = join(tmpdir(), `claustodian-handedited-control-${process.pid}.json`);
    await writeFile(path, JSON.stringify({ source: 'binary', symbols: [] }));
    await expect(loadControlObservations(path)).rejects.toThrow(
      /not a scripts\/backfill-binary\.ts output/
    );
    await rm(path, { force: true });
  });
});
describe('controlRecordDating — ceiling agrees with the extractor', () => {
  // `controlRecordDating` restates `controlMessageConfidence` rather than importing it,
  // because control-lane.ts pulls in the native oxc-parser and binary-lane.ts is on the
  // scrape path. Every `ControlEvidence` value below is crossed with a described and an
  // undescribed subtype. The list is hand-written — `ControlEvidence` is a bare union
  // with no runtime companion — so a fourth member would type-check here and go
  // untested; add it to EVIDENCE when you add it to the union.
  const EVIDENCE: ControlEvidence[] = ['schema', 'call_site', 'dispatch'];

  for (const evidence of EVIDENCE) {
    for (const description of ['', 'Delivers a hook callback.']) {
      it(`agrees for evidence=${evidence}, description=${description === '' ? 'none' : 'set'}`, () => {
        const observation: ControlObservation = {
          symbol: 'hook_callback',
          family: 'control_request',
          first_seen: '2.1.63',
          last_seen: '2.1.226',
          removed_in: null,
          direction_eras: [{ from: '2.1.63', value: null }],
          description_eras: [{ from: '2.1.63', value: description }],
          evidence_eras: [{ from: '2.1.63', value: evidence }],
          // `both` keeps the date anchored, so confidence is the ceiling untouched —
          // which is what makes this a comparison of the ceiling rule alone.
          admitted_at_first_seen: 'both',
        };
        expect(controlRecordDating(observation, '2.1.226').confidence).toBe(
          controlMessageConfidence({ evidence, description })
        );
      });
    }
  }
});
