// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { extractSettingsKeys, SettingsSchemaError, settingsKeyType } from './settings-schema.js';

/** Paths only, for terse assertions. */
const paths = (src: string): string[] => extractSettingsKeys(src).map((k) => k.path);

describe('extractSettingsKeys — namespaced era (0.2.123 → 2.1.223)', () => {
  it('reads top-level keys and their descriptions off the schema root', () => {
    const src =
      'Q=v.object({apiKeyHelper:v.string().optional(),' +
      'cleanupPeriodDays:v.number().optional().describe("Days to retain transcripts")})';
    const keys = extractSettingsKeys(src);
    expect(keys.map((k) => k.path)).toEqual(['apiKeyHelper', 'cleanupPeriodDays']);
    expect(keys[1]?.description).toBe('Days to retain transcripts');
  });

  it('emits a nested inline object as both the parent and its dotted children', () => {
    const src =
      'Q=v.object({apiKeyHelper:v.string(),' +
      'attribution:v.object({commit:v.string().describe("Commit trailer"),pr:v.string()}).optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'attribution', 'attribution.commit', 'attribution.pr']);
  });

  it('does not descend into the zod alias itself', () => {
    // `v.string()` leads with an identifier too; treating it as a sub-schema
    // reference would send the walk chasing the zod namespace.
    const src = 'Q=v.object({apiKeyHelper:v.string().optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper']);
  });
});

describe('extractSettingsKeys — tree-shaken era (2.1.224 →)', () => {
  it('walks a schema with no namespace alias at all', () => {
    // 2.1.224 emits `lt()`/`Ot()` bare, and objects as `Xt({…})`. Anchoring on
    // `<alias>.object({` returns zero keys here, which reads as ~225 removals.
    const src =
      'var st=Ct(),lt=Ct(),Xt=Ct();' +
      'Q=Xt({apiKeyHelper:st().optional(),' +
      'cleanupPeriodDays:lt().int().optional().describe("Days to retain transcripts"),' +
      'attribution:Xt({commit:st()}).optional()})';
    const keys = extractSettingsKeys(src);
    expect(keys.map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'cleanupPeriodDays',
      'attribution',
      'attribution.commit',
    ]);
    expect(keys[1]?.description).toBe('Days to retain transcripts');
  });
});

describe('extractSettingsKeys — sub-schema references', () => {
  it('resolves a CALLED sub-schema factory and prefixes its keys', () => {
    const src =
      'function zWl(e){return v.object({allow:v.array(v.string()),deny:v.array(v.string())})}' +
      'Q=v.object({apiKeyHelper:v.string(),permissions:zWl(e).optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'permissions', 'permissions.allow', 'permissions.deny']);
  });

  it('resolves a CHAINED sub-schema reference', () => {
    // The 1.0.116 shape: `read:H10.optional()`, not `read:H10(…)`. Matching only
    // the called form silently dropped sandbox.filesystem.read.* while the walk
    // still reported success.
    const src =
      'H10=Se(()=>v.object({allow:v.string(),deny:v.string()}));' +
      'Q=v.object({apiKeyHelper:v.string(),read:H10.optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'read', 'read.allow', 'read.deny']);
  });

  it('resolves a $-prefixed factory name', () => {
    // Minified names are often `$`-prefixed, and `\b` cannot match before `$`
    // because `$` is not a word character — so a `\b`-anchored search missed
    // exactly these. That is the whole cause of the phantom sandbox.filesystem.*
    // removals at 2.1.203 and 2.1.210.
    const src =
      '$am=Se(()=>v.object({allowWrite:v.array(v.string()),denyRead:v.array(v.string())}));' +
      'Q=v.object({apiKeyHelper:v.string(),filesystem:$am.optional()})';
    expect(paths(src)).toEqual([
      'apiKeyHelper',
      'filesystem',
      'filesystem.allowWrite',
      'filesystem.denyRead',
    ]);
  });

  it('prefers the binding nearest the reference when a minified name is reused', () => {
    // Bundlers reuse short names across module scopes. Taking the first match in
    // the whole bundle resolved `sandbox` to an unrelated object.
    const src =
      'X=v.object({wrong:v.string()});' +
      'Q=v.object({apiKeyHelper:v.string(),sandbox:X.optional()});' +
      'X=v.object({right:v.string()})';
    expect(paths(src)).toContain('sandbox.wrong');
    expect(paths(src)).not.toContain('sandbox.right');
  });

  it('emits the key but no children when a reference resolves to a non-object', () => {
    // `env` and `hooks` are record schemas keyed by caller-supplied names: no
    // fixed key set to enumerate. That is a legitimate answer, not a failure,
    // and must not be mistaken for an unwalkable schema.
    const src =
      'IU4=v.record(v.string(),v.string());' + 'Q=v.object({apiKeyHelper:v.string(),env:IU4.optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'env']);
  });
});

describe('extractSettingsKeys — hard-fail rather than shrink', () => {
  it('returns empty for a bundle with no settings schema (pre-0.2.116)', () => {
    expect(extractSettingsKeys('function x(){return 1}')).toEqual([]);
  });

  it('throws when a sub-schema reference has no resolvable definition', () => {
    const src = 'Q=v.object({apiKeyHelper:v.string(),permissions:zWl(e).optional()})';
    expect(() => extractSettingsKeys(src)).toThrow(SettingsSchemaError);
    expect(() => extractSettingsKeys(src)).toThrow(/no resolvable definition/);
  });

  it('throws when an anchor is present but the root cannot be reached', () => {
    // An anchor not enclosed by a call-opened object: the emission shape changed.
    expect(() => extractSettingsKeys('let o={cleanupPeriodDays:v.number()}')).toThrow(SettingsSchemaError);
  });

  it('names the offending key so a failure is diagnosable', () => {
    const src = 'Q=v.object({apiKeyHelper:v.string(),sandbox:missingFn(e)})';
    expect(() => extractSettingsKeys(src)).toThrow(/sandbox/);
  });
});

describe('extractSettingsKeys — descriptions', () => {
  it('drops a template-literal description (its interpolation churns per build)', () => {
    const src = 'Q=v.object({apiKeyHelper:v.string().describe(`Path ${K4} helper`)})';
    expect(extractSettingsKeys(src)[0]?.description).toBeUndefined();
  });

  it('unescapes quotes inside a description', () => {
    const src = String.raw`Q=v.object({apiKeyHelper:v.string().describe("Use \"auto\" to pick")})`;
    expect(extractSettingsKeys(src)[0]?.description).toBe('Use "auto" to pick');
  });
});

describe('settingsKeyType', () => {
  it('routes an @internal key to internal_config_flag', () => {
    expect(settingsKeyType({ path: 'x', description: '@internal Plumbing only' })).toBe(
      'internal_config_flag'
    );
  });

  it('routes an ordinary key to config_key', () => {
    expect(settingsKeyType({ path: 'model', description: 'Override the default model' })).toBe('config_key');
    expect(settingsKeyType({ path: 'model' })).toBe('config_key');
  });
});
