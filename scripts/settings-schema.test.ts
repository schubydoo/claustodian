// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  extractSettingsKeys,
  SettingsSchemaError,
  settingsKeyCategory,
} from './settings-schema.js';

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
    expect(paths(src)).toEqual([
      'apiKeyHelper',
      'attribution',
      'attribution.commit',
      'attribution.pr',
    ]);
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
    expect(paths(src)).toEqual([
      'apiKeyHelper',
      'permissions',
      'permissions.allow',
      'permissions.deny',
    ]);
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

  it('resolves a sub-schema defined AFTER its use', () => {
    // Lazy bindings are emitted below their reference, so there is nothing behind
    // to find and the search has to look ahead.
    const src =
      'Q=v.object({apiKeyHelper:v.string(),worktree:W10.optional()});' +
      'W10=Se(()=>v.object({baseRef:v.string(),sparsePaths:v.array(v.string())}))';
    expect(paths(src)).toEqual([
      'apiKeyHelper',
      'worktree',
      'worktree.baseRef',
      'worktree.sparsePaths',
    ]);
  });

  it('emits the key but no children when a reference resolves to a non-object', () => {
    // `env` and `hooks` are record schemas keyed by caller-supplied names: no
    // fixed key set to enumerate. That is a legitimate answer, not a failure,
    // and must not be mistaken for an unwalkable schema.
    const src =
      'IU4=v.record(v.string(),v.string());' +
      'Q=v.object({apiKeyHelper:v.string(),env:IU4.optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'env']);
  });

  it('does not descend a two-arg inline record even when its builder name collides', () => {
    // A `record(keySchema,valueSchema)` passed inline — `Pe(i(),i())` — keys on
    // caller-supplied names and has no fixed sub-keys. It is skipped WITHOUT
    // resolving the callee, which matters because the callee name is minified and
    // reused: at 2.1.251 the record builder and an unrelated `Pe=m(()=>v.object(…))`
    // lazy object were both named `Pe`, so resolving it descended into that object
    // and invented a `modelOverrides.enabled.pricing_tiers…` cycle until the depth
    // guard refused the whole version. The two-arg record shape is decisive on its
    // own — the collision binding here would descend if the callee were resolved.
    const src =
      'Q=v.object({apiKeyHelper:v.string(),modelOverrides:Pe(i(),i()).optional()});' +
      'Pe=Se(()=>v.object({enabled:v.boolean(),pricing_tiers:v.string()}))';
    expect(paths(src)).toEqual(['apiKeyHelper', 'modelOverrides']);
  });

  it('still descends a single-argument reference — the record guard is two-arg only', () => {
    // The guard is deliberately narrow. A one-arg call (`array(elementSchema)`, or a
    // sub-schema factory taking a context arg) is NOT a keyed record, so it is left
    // to normal resolution — widening the guard to one arg would change what a
    // same-named collision descends into elsewhere (e.g. `permissions.args:H(i())`).
    const src =
      'Wrap=Se(()=>v.object({allow:v.string(),deny:v.string()}));' +
      'Q=v.object({apiKeyHelper:v.string(),sub:Wrap(inner()).optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'sub', 'sub.allow', 'sub.deny']);
  });
});

describe('extractSettingsKeys — depth accounting at the object top level', () => {
  it('steps over a spread call without mistaking its arguments for keys', () => {
    // `...withDefaults(base)` sits at the object's top level, so its parens are
    // walked by the outer loop rather than skipped as part of a value.
    const src = 'Q=v.object({...withDefaults(base),apiKeyHelper:v.string(),model:v.string()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'model']);
  });

  it('does not settle on a previous sibling sub-object when locating the root', () => {
    // The anchor is preceded by an inline sub-object, so the nearest call-opened
    // brace going backward is the SIBLING, not the root. Anchoring on it would
    // root the walk one level too deep and lose every earlier top-level key.
    const src =
      'Q=v.object({attribution:v.object({commit:v.string()}),cleanupPeriodDays:v.number()})';
    expect(paths(src)).toEqual(['attribution', 'attribution.commit', 'cleanupPeriodDays']);
  });

  it('steps over a nested object literal at the top level', () => {
    const src = 'Q=v.object({...{legacy:1},apiKeyHelper:v.string()})';
    expect(paths(src)).toEqual(['apiKeyHelper']);
  });

  it('steps over a computed key without leaking the bracket contents', () => {
    const src = 'Q=v.object({["computed,name"]:v.string(),apiKeyHelper:v.string()})';
    expect(paths(src)).toEqual(['apiKeyHelper']);
  });

  it('does not treat a brace inside a string value as the end of the object', () => {
    const src =
      'Q=v.object({apiKeyHelper:v.string().describe("Use {braces} and, commas"),model:v.string()})';
    const keys = extractSettingsKeys(src);
    expect(keys.map((k) => k.path)).toEqual(['apiKeyHelper', 'model']);
    expect(keys[0]?.description).toBe('Use {braces} and, commas');
  });

  it('terminates on a truncated bundle instead of running off the end', () => {
    // An unterminated string literal: the scanner must stop, not loop forever.
    expect(() =>
      extractSettingsKeys('Q=v.object({apiKeyHelper:v.string().describe("unclosed')
    ).not.toThrow(RangeError);
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
    expect(() => extractSettingsKeys('let o={cleanupPeriodDays:v.number()}')).toThrow(
      SettingsSchemaError
    );
  });

  it('throws rather than truncating when nesting runs away', () => {
    // A self-referential sub-schema. Returning at the depth cap would drop every
    // key below it while reporting success.
    const src =
      'C=Se(()=>v.object({deeper:C.optional()}));Q=v.object({apiKeyHelper:v.string(),root:C.optional()})';
    expect(() => extractSettingsKeys(src)).toThrow(/nesting exceeded/);
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

describe('settingsKeyCategory', () => {
  it('routes an @internal description to settings-internal', () => {
    expect(settingsKeyCategory('@internal Plumbing only')).toBe('settings-internal');
  });

  it('routes an ordinary or absent description to settings', () => {
    expect(settingsKeyCategory('Override the default model')).toBe('settings');
    expect(settingsKeyCategory(undefined)).toBe('settings');
  });

  it('marks internal-ness on CATEGORY so a description edit cannot split identity', () => {
    // At 2.1.154 the `@internal` prefix was dropped from disableWorkflows. When
    // that drove the symbol TYPE it changed the record's `type:symbol` identity,
    // publishing a false removal of the old type at exactly that version while
    // the key sat untouched in the schema. Category is not identity, so the same
    // edit is now just an update.
    expect(settingsKeyCategory('@internal Disable the Workflows feature')).toBe(
      'settings-internal'
    );
    expect(settingsKeyCategory('Disable the Workflows feature')).toBe('settings');
  });
});

describe('extractSettingsKeys — feature-gated fragments', () => {
  /** A minimal root the anchor regex can find, so the walk has somewhere to start. */
  const ROOT = 'Q=v.object({apiKeyHelper:v.string().optional()})';

  it('reads keys from a gated fragment the root cannot reach', () => {
    // The registry is merged into the schema at build time, so nothing in the root
    // object points at it. At 2.1.226 this hid six keys settings.md documents.
    const src =
      `${ROOT};Nlo={voice:{buildGate:()=>!0,` +
      'shape:()=>({voiceEnabled:v.boolean().optional().describe("Enable voice mode")})}}';
    const keys = extractSettingsKeys(src);
    expect(keys.map((k) => k.path)).toEqual(['apiKeyHelper', 'voiceEnabled']);
    expect(keys[1]?.description).toBe('Enable voice mode');
    expect(keys[1]?.viaFactory).toBe('gated-fragment');
  });

  it('descends into a nested object inside a fragment', () => {
    const src =
      `${ROOT};N={autoMode:{buildGate:()=>!0,shape:()=>({` +
      'autoMode:v.object({allow:v.array().optional().describe("Allow rules"),soft_deny:v.array().optional()})})}}';
    expect(paths(src)).toEqual([
      'apiKeyHelper',
      'autoMode',
      'autoMode.allow',
      'autoMode.soft_deny',
    ]);
  });

  it("ignores zod's own shape() factories", () => {
    // ZodObject.extend()/merge() build `shape:()=>({...this._def.shape(), …})`.
    // Walking those would emit library plumbing as Claude Code settings.
    const src = `${ROOT};class KN{extend(e){return new KN({shape:()=>({...this._def.shape(),...e})})}}`;
    expect(paths(src)).toEqual(['apiKeyHelper']);
  });

  it('throws on an unrecognised shape() factory rather than dropping its keys', () => {
    // Neither gated by buildGate nor zod's own. Silently skipping it would report
    // success while a whole fragment of keys went missing — the failure this
    // module exists to prevent.
    const src = `${ROOT};X={shape:()=>({mysteryKey:Ut().optional()})}`;
    expect(() => extractSettingsKeys(src)).toThrow(SettingsSchemaError);
    expect(() => extractSettingsKeys(src)).toThrow(/neither gated by buildGate/);
  });

  it('collects a fragment key only once when the bundle embeds it twice', () => {
    // 2.1.113 carries two copies of the module graph, so every gated key was
    // read twice and published as a duplicate symbol.
    const frag = 'F={voice:{buildGate:()=>!0,shape:()=>({voiceEnabled:v.boolean().optional()})}}';
    expect(paths(`${ROOT};${frag};${frag}`)).toEqual(['apiKeyHelper', 'voiceEnabled']);
  });

  it('lets a root declaration win over a same-named fragment key', () => {
    // The root is the authoritative shape; the fragment copy is the duplicate.
    const src =
      'Q=v.object({apiKeyHelper:v.string(),voiceEnabled:v.boolean().describe("From the root")});' +
      'F={voice:{buildGate:()=>!0,shape:()=>({voiceEnabled:v.boolean().optional().describe("From a fragment")})}}';
    const keys = extractSettingsKeys(src);
    expect(keys.filter((k) => k.path === 'voiceEnabled')).toHaveLength(1);
    expect(keys.find((k) => k.path === 'voiceEnabled')?.description).toBe('From the root');
  });

  it('is unaffected in an era with no fragments at all', () => {
    expect(paths(ROOT)).toEqual(['apiKeyHelper']);
  });
});

describe('extractSettingsKeys — a parent object never borrows a child description', () => {
  it('leaves a parent undescribed when only its children carry describe()', () => {
    // The shipped defect: describeOf took the first `.describe()` in the value,
    // and for an object that is the FIRST CHILD's. `worktree` was published
    // describing the symlink array that is really `worktree.symlinkDirectories`,
    // and 8 of 20 parents were wrong the same way at 2.1.226.
    const src =
      'Q=v.object({apiKeyHelper:v.string(),' +
      'worktree:v.object({symlinkDirectories:v.array().describe("Dirs to symlink"),' +
      'baseRef:v.string().describe("Which ref")}).optional()})';
    const keys = extractSettingsKeys(src);
    const by = new Map(keys.map((k) => [k.path, k.description]));
    expect(by.get('worktree')).toBeUndefined();
    expect(by.get('worktree.symlinkDirectories')).toBe('Dirs to symlink');
    expect(by.get('worktree.baseRef')).toBe('Which ref');
  });

  it('reads a parent description chained after the object closes', () => {
    const src =
      'Q=v.object({apiKeyHelper:v.string(),' +
      'remote:v.object({defaultEnvironmentId:v.string().describe("Default env ID")})' +
      '.describe("Cloud session configuration").optional()})';
    const by = new Map(extractSettingsKeys(src).map((k) => [k.path, k.description]));
    expect(by.get('remote')).toBe('Cloud session configuration');
    expect(by.get('remote.defaultEnvironmentId')).toBe('Default env ID');
  });

  it('is not desynced by a brace inside a child description', () => {
    // The tail is found by counting braces, so a `{` inside a string would make
    // the object appear to close late and swallow the parent's own describe().
    const src =
      'Q=v.object({apiKeyHelper:v.string(),' +
      'statusLine:v.object({command:v.string().describe("Use {cwd} in the template")})' +
      '.describe("Status line configuration")})';
    const by = new Map(extractSettingsKeys(src).map((k) => [k.path, k.description]));
    expect(by.get('statusLine')).toBe('Status line configuration');
    expect(by.get('statusLine.command')).toBe('Use {cwd} in the template');
  });

  it('still describes an ordinary scalar key from its own chain', () => {
    const src =
      'Q=v.object({apiKeyHelper:v.string(),cleanupPeriodDays:v.number().describe("Days")})';
    const by = new Map(extractSettingsKeys(src).map((k) => [k.path, k.description]));
    expect(by.get('cleanupPeriodDays')).toBe('Days');
  });

  it('gives a grandparent nothing when only a grandchild is described', () => {
    const src =
      'Q=v.object({apiKeyHelper:v.string(),' +
      'sandbox:v.object({network:v.object({allowedDomains:v.array().describe("Domains")})})})';
    const by = new Map(extractSettingsKeys(src).map((k) => [k.path, k.description]));
    expect(by.get('sandbox')).toBeUndefined();
    expect(by.get('sandbox.network')).toBeUndefined();
    expect(by.get('sandbox.network.allowedDomains')).toBe('Domains');
  });
});

describe('extractSettingsKeys — an object whose body never closes', () => {
  it('gives the parent no description rather than reading past the value', () => {
    // objectEnd scans `src`, not the value slice, so an unterminated object would
    // otherwise run to the end of the bundle and hand back whatever `.describe()`
    // it found there — a description belonging to an unrelated key.
    // Truncated mid-object: the brace never arrives before end-of-source.
    const src =
      'Q=v.object({apiKeyHelper:v.string(),broken:v.object({a:v.string().describe("Child")';
    const by = new Map(extractSettingsKeys(src).map((k) => [k.path, k.description]));
    expect(by.get('broken')).toBeUndefined();
    expect(by.get('broken.a')).toBe('Child');
  });
});
