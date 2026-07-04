// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { glob } from 'tinyglobby';

import { buildAjv, getValidator, schemaKindFor } from './validate-schema.js';

/**
 * A well-formed changelog/high symbol record. Individual tests clone this via
 * `validSymbol({...overrides})` and mutate/override just the field(s) under
 * test, so each test stays focused on one deviation from a known-good shape.
 */
function validSymbol(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claudeCodeVersion: '2.1.201',
    schemaVersion: '1.0.0',
    symbols: [validSymbol()],
    ...overrides,
  };
}

function validIndex(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    latest: '2.1.201',
    versions: ['2.1.201', '2.1.169', '2.0.64'],
    ...overrides,
  };
}

describe('symbol schema', () => {
  const ajv = buildAjv();
  const validate = getValidator(ajv, 'symbol');

  it('passes for a well-formed changelog/high record', () => {
    expect(validate(validSymbol())).toBe(true);
  });

  it('fails when a required field (category) is missing', () => {
    const record = validSymbol();
    delete record.category;
    expect(validate(record)).toBe(false);
  });

  it('fails for an unrecognized enum value', () => {
    expect(validate(validSymbol({ type: 'bogus' }))).toBe(false);
  });

  it('fails when first_seen is the wrong type (number, not string)', () => {
    expect(validate(validSymbol({ first_seen: 123 }))).toBe(false);
  });

  it('fails when first_seen does not match the version pattern', () => {
    expect(validate(validSymbol({ first_seen: '2.1' }))).toBe(false);
  });

  it('fails when provenance=changelog is paired with confidence=medium', () => {
    expect(validate(validSymbol({ provenance: 'changelog', confidence: 'medium' }))).toBe(false);
  });

  it('passes when provenance=binary is paired with confidence=medium', () => {
    expect(validate(validSymbol({ provenance: 'binary', confidence: 'medium' }))).toBe(true);
  });

  it('fails when an unknown extra property is present', () => {
    expect(validate(validSymbol({ extra_field: 'not allowed' }))).toBe(false);
  });
});

describe('snapshot schema', () => {
  const ajv = buildAjv();
  const validate = getValidator(ajv, 'snapshot');

  it('passes for a well-formed snapshot', () => {
    expect(validate(validSnapshot())).toBe(true);
  });

  it('fails when a nested symbol is missing a required field', () => {
    const badSymbol = validSymbol();
    delete badSymbol.category;
    expect(validate(validSnapshot({ symbols: [badSymbol] }))).toBe(false);
  });
});

describe('index schema', () => {
  const ajv = buildAjv();
  const validate = getValidator(ajv, 'index');

  it('passes for a well-formed index', () => {
    expect(validate(validIndex())).toBe(true);
  });

  it('fails when a versions[] entry does not match the version pattern', () => {
    expect(validate(validIndex({ versions: ['2.1'] }))).toBe(false);
  });
});

describe('real data files', () => {
  it('validates every committed file under data/**/*.json against its routed schema', async () => {
    const files = await glob(['data/**/*.json'], { absolute: false, dot: false });
    files.sort();

    // Guard against a silently-empty glob making this test vacuously pass.
    expect(files.length).toBeGreaterThan(0);

    const ajv = buildAjv();

    for (const filePath of files) {
      const kind = schemaKindFor(filePath);
      if (!kind) {
        // Same "no matching route" allowance the CLI applies (SKIP).
        continue;
      }

      const raw = await readFile(filePath, 'utf-8');
      const data: unknown = JSON.parse(raw);
      const validate = getValidator(ajv, kind);
      const valid = validate(data);

      expect(valid, `${filePath} (${kind}): ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});
