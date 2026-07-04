import { load } from 'js-yaml';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { stripNulls, toToml, toYaml } from './generate-exports.js';

/**
 * A sample snapshot-shaped object with a record containing `removed_in:
 * null` and `source_url: null` — mirrors the real `data/versions/*.json`
 * shape closely enough to exercise the null-handling asymmetry between
 * `toYaml` (preserves null) and `toToml` (strips null keys).
 */
function sampleSnapshot(): Record<string, unknown> {
  return {
    claudeCodeVersion: '2.1.201',
    schemaVersion: '1.0.0',
    symbols: [
      {
        symbol: '--safe-mode',
        type: 'cli_flag',
        first_seen: '2.1.169',
        removed_in: null,
        status: 'active',
        provenance: 'changelog',
        confidence: 'high',
        description: 'Starts Claude Code with all customizations disabled.',
        source_url: null,
        category: 'startup',
      },
    ],
  };
}

describe('toYaml', () => {
  it('round-trips the sample object exactly, preserving null values', () => {
    const obj = sampleSnapshot();
    const yamlText = toYaml(obj);
    const loaded = load(yamlText);
    expect(loaded).toEqual(obj);

    const symbols = (loaded as { symbols: Array<Record<string, unknown>> }).symbols;
    expect(symbols[0]?.removed_in).toBeNull();
    expect(symbols[0]?.source_url).toBeNull();
  });
});

describe('toToml', () => {
  it('round-trips the sample object with null-valued keys removed', () => {
    const obj = sampleSnapshot();
    const tomlText = toToml(obj);
    const parsed = parse(tomlText);

    const expected = stripNulls(obj);
    expect(parsed).toEqual(expected);

    const symbols = (parsed as { symbols: Array<Record<string, unknown>> }).symbols;
    expect(symbols[0]).not.toHaveProperty('removed_in');
    expect(symbols[0]).not.toHaveProperty('source_url');
  });

  it('does not mutate the input object', () => {
    const obj = sampleSnapshot();
    const before = JSON.stringify(obj);
    toToml(obj);
    expect(JSON.stringify(obj)).toBe(before);
  });
});

describe('stripNulls', () => {
  it('drops only null-valued object keys, recursively', () => {
    const input = {
      a: 1,
      b: null,
      nested: {
        c: 'keep',
        d: null,
        deeper: { e: null, f: 'ok' },
      },
    };
    expect(stripNulls(input)).toEqual({
      a: 1,
      nested: {
        c: 'keep',
        deeper: { f: 'ok' },
      },
    });
  });

  it('recurses into arrays, keeping null array elements but stripping null keys in object elements', () => {
    const input = {
      list: [{ x: 1, y: null }, null, 'plain', { z: null }],
    };
    expect(stripNulls(input)).toEqual({
      list: [{ x: 1 }, null, 'plain', {}],
    });
  });

  it('leaves non-object, non-array values (including falsy ones) untouched', () => {
    expect(stripNulls(0)).toBe(0);
    expect(stripNulls('')).toBe('');
    expect(stripNulls(false)).toBe(false);
    expect(stripNulls(undefined)).toBe(undefined);
  });
});
