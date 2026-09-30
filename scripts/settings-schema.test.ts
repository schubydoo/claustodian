// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  extractSettingsKeys,
  SettingsSchemaError,
  settingsKeyCategory,
} from './settings-schema.js';

/** Paths only, for terse assertions. */
const paths = (src: string | readonly string[]): string[] =>
  extractSettingsKeys(src).map((k) => k.path);

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

describe('extractSettingsKeys — thunked era (2.1.284 →)', () => {
  // 2.1.284 returns the root as a plain object of thunks, which a lazy wrapper
  // builds field by field: `function la(e){return{apiKeyHelper:()=>o(),…}}`.
  // Neither the anchor nor the root matched that shape, so the lane refused.
  const builders = 'var o=Ct(),k=Ct(),u=Ct(),H=Ct();function Fe(e){return new Zn(e)}';

  it('walks a returned root whose values are thunks', () => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o().optional(),' +
      'cleanupPeriodDays:()=>k().int().optional().describe("Days to retain transcripts"),' +
      'attribution:()=>u({commit:o().describe("Commit trailer")}).optional()}}';
    const keys = extractSettingsKeys(src);
    expect(keys.map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'cleanupPeriodDays',
      'attribution',
      'attribution.commit',
    ]);
    expect(keys[1]?.description).toBe('Days to retain transcripts');
    expect(keys[2]?.description).toBeUndefined();
  });

  it("reads a block-bodied thunk's own return, not its first child's description", () => {
    // At 2.1.284 `attribution` builds its object inside the block and returns a
    // union, so the first `.describe()` in the value is `commit`'s. The nested
    // `return` AFTER the top-level one is the 2.1.284 `.transform((d)=>{…})`
    // shape: taking it would start the span past the parent's `.describe()`.
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'attribution:()=>{let i=u({commit:o().describe("Commit trailer")});' +
      'return Fe([H(),i]).describe("Customize attribution")' +
      '.transform((d)=>{return d}).optional()}}}';
    const attribution = extractSettingsKeys(src).find((k) => k.path === 'attribution');
    expect(attribution?.description).toBe('Customize attribution');
  });

  it('throws on a block-bodied thunk with no top-level return', () => {
    const src =
      builders + 'function la(e){return{apiKeyHelper:()=>o(),attribution:()=>{let i=u({})}}}';
    expect(() => extractSettingsKeys(src)).toThrow(SettingsSchemaError);
    expect(() => extractSettingsKeys(src)).toThrow(/"attribution".*no top-level return/);
  });

  it('does not read an identifier that merely contains "return" as the keyword', () => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),attribution:()=>{let returned=o(),xreturn=o()}}}';
    expect(() => extractSettingsKeys(src)).toThrow(/"attribution".*no top-level return/);
  });

  it('throws on a second top-level return rather than walking one branch', () => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'attribution:()=>{if(e)return u({commit:o()});return u({pr:o()})}}}';
    expect(() => extractSettingsKeys(src)).toThrow(/"attribution".*top-level IfStatement/);
    const bare =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'attribution:()=>{return u({commit:o()});return u({pr:o()})}}}';
    expect(() => extractSettingsKeys(bare)).toThrow(
      /"attribution".*more than one top-level return/
    );
  });

  it('throws on a braced branch that could hide another return', () => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'attribution:()=>{if(e){return u({commit:o()})}return u({pr:o()})}}}';
    expect(() => extractSettingsKeys(src)).toThrow(/"attribution".*top-level IfStatement/);
  });

  it('does not read a property access such as Symbol.for as a keyword', () => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'attribution:()=>{let s=Symbol.for("x"),t=g.return;return u({commit:o()})}}}';
    expect(paths(src)).toEqual(['apiKeyHelper', 'attribution', 'attribution.commit']);
  });

  it.each([
    ['a regex literal', 'let p=/if|return/g;'],
    ['a regex whose class holds a slash', 'let p=/[/]if/;'],
    ['a regex with an escaped slash', 'let p=/\\/if/;'],
    ['a regex after a keyword', 'void /if/;'],
    ['a block comment', '/* if(e){return a} */'],
    ['a line comment', '// if(e){return a}\n'],
    ['a division', 'let n=e/2;'],
    ['a division after an increment', 'let n=e++/2;'],
    ['a nested template literal', 'let t=`${e?`if`:""}`;'],
  ])('reads a straight-line block holding %s', (_, statement) => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      `attribution:()=>{${statement}return u({commit:o()})}}}`;
    expect(paths(src)).toEqual(['apiKeyHelper', 'attribution', 'attribution.commit']);
  });

  it.each([
    ['block comment', '/* return u({commit:o()})'],
    ['line comment', '// return u({commit:o()})'],
  ])('throws when a %s never closes, rather than reading inside it', (_, statement) => {
    const src =
      builders + `function la(e){return{apiKeyHelper:()=>o(),attribution:()=>{${statement}}}}`;
    expect(() => extractSettingsKeys(src)).toThrow(/"attribution".*not one expression/);
  });

  it.each([
    ['a statement after its return', 'return u({commit:o()});e()', /statement after its return/],
    ['a return with no value', 'return', /return has no value/],
  ])('throws on %s', (_, statement, message) => {
    const src =
      builders + `function la(e){return{apiKeyHelper:()=>o(),attribution:()=>{${statement}}}}`;
    expect(() => extractSettingsKeys(src)).toThrow(message);
  });

  it('maps the return back to the bundle past non-ASCII text in the block', () => {
    // oxc reports UTF-16 offsets, the same unit as a JavaScript string index. A
    // byte offset would land past the return and lose the parent's description.
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'attribution:()=>{let s="·é—";return u({commit:o()}).describe("Own")}}}';
    const attribution = extractSettingsKeys(src).find((k) => k.path === 'attribution');
    expect(attribution?.description).toBe('Own');
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

  it('resolves a builder declared as a plain function to no children', () => {
    // zod's `enum` is `function Dr(e,t){let r=…;return new X({type:"enum"…})}` — a
    // declaration whose body does not open with `return`. It is a definition, so
    // the reference is not unresolvable; it is just not an object literal.
    const src =
      'function Dr(e,t){let r=e;return new Gxn({type:"enum",entries:r})}' +
      'Q=v.object({apiKeyHelper:v.string(),defaultMode:Dr(["default","plan"]).optional()})';
    expect(paths(src)).toEqual(['apiKeyHelper', 'defaultMode']);
  });
});

describe('extractSettingsKeys — code-split era (2.1.242 →)', () => {
  // From 2.1.242 the bundle is a list of ES-module chunks, each minifying its own
  // names, linked by `import{E as L}from"/$bunfs/root/chunk-x.js"`. The walk gets
  // the list and must resolve every name inside the chunk that binds it.
  const ROOT = '/$bunfs/root/';

  it('resolves a name inside the schema chunk, not a same-named binding in another chunk', () => {
    // At 2.1.261 `Ne` was the union builder in the settings chunk and an unrelated
    // lazy object `{jws,receivedAt}` in a login chunk. Walking the flat
    // concatenation resolved `theme:Ne([…])` to the login object and published
    // `theme.jws`.
    const login =
      'Ne=m(()=>v.object({jws:v.string(),receivedAt:v.number()}));export{Ne as tokenShape}';
    const settings =
      'function Ne(e,r){return new As({type:"union",options:e})}' +
      'Q=v.object({apiKeyHelper:v.string(),theme:Ne([v.enum(["light","dark"]),v.string()]).optional()})';
    expect(paths([login, settings])).toEqual(['apiKeyHelper', 'theme']);
    // The same defect through a CALLED reference, which still resolves the callee
    // by name: scoped to its chunk it finds the union builder, flat it finds the
    // login object. (A union value no longer resolves its callee at all.)
    const called =
      'function Ne(e,r){return new As({type:"union",options:e})}' +
      'Q=v.object({apiKeyHelper:v.string(),theme:Ne(e).optional()})';
    expect(paths([login, called])).toEqual(['apiKeyHelper', 'theme']);
    expect(paths(login + ';' + called)).toContain('theme.jws');
  });

  it('resolves an imported sub-schema through the module that exports it', () => {
    // `hooks:dN()` at 2.1.248 imports `dN` from another chunk. The source string
    // names no chunk directly; the chunk that exports every name imported from
    // that source IS the module. The exported name is the module's local `H10`.
    // A side-effect import (`import{}from"…"`) and an empty export list bind
    // nothing and must not trip the parse.
    const schema =
      `import{}from"${ROOT}chunk-side.js";import{P as dN}from"${ROOT}chunk-a.js";` +
      'Q=v.object({apiKeyHelper:v.string(),hooks:dN().optional()})';
    const other = 'dN=m(()=>v.object({wrong:v.string()}));export{dN as unrelated};export{}';
    const hooks =
      'H10=m(()=>v.object({PreToolUse:v.string(),PostToolUse:v.string()}));export{H10 as P}';
    expect(paths([other, schema, hooks])).toEqual([
      'apiKeyHelper',
      'hooks',
      'hooks.PreToolUse',
      'hooks.PostToolUse',
    ]);
  });

  it('follows a re-exported name one module further', () => {
    const schema =
      `import{P as dN}from"${ROOT}chunk-a.js";` + 'Q=v.object({apiKeyHelper:v.string(),sub:dN()})';
    const facade = `import{R as P}from"${ROOT}chunk-b.js";export{P}`;
    const real = 'R=m(()=>v.object({inner:v.string()}));export{R}';
    expect(paths([schema, facade, real])).toEqual(['apiKeyHelper', 'sub', 'sub.inner']);
  });

  it('throws rather than looping when re-exports form a cycle', () => {
    // Each chunk also exports a name of its own, so both modules identify
    // uniquely and the walk genuinely hops between them.
    const schema =
      `import{P as dN,Ax}from"${ROOT}chunk-a.js";` +
      'Q=v.object({apiKeyHelper:v.string(),sub:dN()})';
    const a = `import{P as R,Bx}from"${ROOT}chunk-b.js";Ax=1;export{R as P,Ax}`;
    const b = `import{P as R,Ax}from"${ROOT}chunk-a.js";Bx=1;export{R as P,Bx}`;
    expect(() => extractSettingsKeys([schema, a, b])).toThrow(/re-exports in a cycle/);
  });

  it('throws when the imported module cannot be identified', () => {
    // Zero chunks export the name: the source is unidentifiable. Guessing would
    // resolve against whatever chunk happens to reuse the name — the very defect.
    const schema =
      `import{P as dN}from"${ROOT}chunk-a.js";` + 'Q=v.object({apiKeyHelper:v.string(),sub:dN()})';
    expect(() => extractSettingsKeys([schema, 'dN=m(()=>v.object({wrong:v.string()}))'])).toThrow(
      SettingsSchemaError
    );
    // Several chunks export it: equally unidentifiable.
    const twin = 'P=m(()=>v.object({a:v.string()}));export{P}';
    expect(() => extractSettingsKeys([schema, twin, twin])).toThrow(/cannot identify uniquely/);
  });

  it('walks a gated fragment in the chunk that holds it, resolving there', () => {
    const settings = 'Q=v.object({apiKeyHelper:v.string().optional()})';
    const feature =
      'Vm=m(()=>v.object({allow:v.string()}));' +
      'N={autoMode:{buildGate:()=>!0,shape:()=>({autoMode:Vm().optional()})}}';
    // A same-named `Vm` in the settings chunk must not be what the fragment resolves.
    const keys = extractSettingsKeys([
      `Vm=m(()=>v.object({wrong:v.string()}));${settings}`,
      feature,
    ]);
    expect(keys.map((k) => k.path)).toEqual(['apiKeyHelper', 'autoMode', 'autoMode.allow']);
  });

  it('does not register an import spelled inside a string literal', () => {
    // Only a statement-position `import{…}from"…"` binds a name.
    const settings =
      `T='import{Ne}from"${ROOT}chunk-z.js"';` +
      'Ne=m(()=>v.object({allow:v.string()}));Q=v.object({apiKeyHelper:v.string(),sub:Ne()})';
    expect(paths([settings, 'Ne=m(()=>v.object({wrong:v.string()}));export{Ne}'])).toEqual([
      'apiKeyHelper',
      'sub',
      'sub.allow',
    ]);
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

describe('extractSettingsKeys — union members (2.1.281 →)', () => {
  // From 2.1.281 `attribution` is a union of a boolean and an object held in a
  // local: `Fe([H(),i],{…})`. Resolving the callee reached the union builder and
  // dropped `attribution.commit`, `.pr` and `.sessionUrl`.
  const builders = 'var o=Ct(),u=Ct(),H=Ct();function Fe(e,n){return new Zn(e)}';

  it('reads the object member a local binds before the root (2.1.281 → 2.1.283)', () => {
    const src =
      builders +
      'function la(e){let r=(d)=>d,i=u({commit:o().describe("Commit"),pr:o()}).passthrough();' +
      'return u({apiKeyHelper:o(),attribution:Fe([H(),i],{error:(d)=>d}).pipe(i).optional()})}';
    const keys = extractSettingsKeys(src);
    expect(keys.map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'attribution',
      'attribution.commit',
      'attribution.pr',
    ]);
    expect(keys[2]?.description).toBe('Commit');
  });

  it('reads the object member a local binds inside a block thunk (2.1.284 →)', () => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'attribution:()=>{let i=u({commit:o()});return Fe([H(),i]).optional()}}}';
    expect(extractSettingsKeys(src).map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'attribution',
      'attribution.commit',
    ]);
  });

  it('reads an inline object member', () => {
    const src = builders + 'Q=u({apiKeyHelper:o(),attribution:Fe([H(),u({commit:o()})])})';
    expect(extractSettingsKeys(src).map((k) => k.path)).toContain('attribution.commit');
  });

  it('keeps the plain path for an array call with no member that can carry keys', () => {
    // An enum or a scalar-only call is not read as a union, so its callee is still
    // resolved: a factory taking an array keeps its children.
    const src =
      builders +
      'function Pz(e){return u({allow:o(),deny:o()})}' +
      'Q=u({apiKeyHelper:o(),perms:Pz(["allow","deny"]),theme:Fe([o(),H(),"dark"])})';
    expect(extractSettingsKeys(src).map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'perms',
      'perms.allow',
      'perms.deny',
      'theme',
    ]);
  });

  it('reads an inline object member behind a method chain', () => {
    const src =
      builders + 'Q=u({apiKeyHelper:o(),attribution:Fe([H(),u({commit:o()}).passthrough()])})';
    expect(extractSettingsKeys(src).map((k) => k.path)).toContain('attribution.commit');
  });

  it('skips a spread or empty member and still reads the bound one', () => {
    const src =
      builders +
      'function la(e){let i=u({commit:o()});' +
      'return u({apiKeyHelper:o(),attribution:Fe([,...e,H(),i])})}';
    expect(extractSettingsKeys(src).map((k) => k.path)).toContain('attribution.commit');
  });

  it('throws on a member reassigned inside a comma expression', () => {
    const src =
      builders +
      'function la(e){let i=u({commit:o()});i=u({x:o()}),f(e);' +
      'return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(() => extractSettingsKeys(src)).toThrow(/names i, which has been reassigned/);
  });

  it('throws when no enclosing block of the root parses', () => {
    // The root's `return` sits at the top level, so no brace before it opens a
    // block that holds it, and the member has no binding in scope.
    const src = builders + 'return u({apiKeyHelper:o(),attribution:Fe([H(),i])})';
    expect(() => extractSettingsKeys(src)).toThrow(/names i, which has no binding/);
  });

  it('reads a local declared by an earlier statement in the root block', () => {
    const src =
      builders +
      'function la(e){let i=u({commit:o()});f(e);let r=e;' +
      'return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(extractSettingsKeys(src).map((k) => k.path)).toContain('attribution.commit');
  });

  it.each([
    [
      'in the root block',
      'function la(e){let i=u({commit:o()});i=u({x:o()});return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}',
    ],
    [
      'in a block thunk',
      'function la(e){return{apiKeyHelper:()=>o(),attribution:()=>{let i=u({commit:o()});i=u({x:o()});return Fe([H(),i])}}}',
    ],
  ])('throws on a member reassigned %s', (_, body) => {
    expect(() => extractSettingsKeys(builders + body)).toThrow(
      /names i, which has been reassigned/
    );
  });

  it('throws on a member name with no binding in scope, even when one exists elsewhere', () => {
    // `i` is a parameter here. An unrelated `i=u({x:…})` earlier in the bundle
    // must not be taken for it: that would publish a phantom `attribution.x`.
    const src =
      builders +
      'var i=u({x:o()});' +
      'function la(e,i){return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(() => extractSettingsKeys(src)).toThrow(/"attribution" names i, which has no binding/);
  });

  it('throws on a local that aliases a name it cannot see', () => {
    const src =
      builders + 'function la(e){let i=e;return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(() => extractSettingsKeys(src)).toThrow(/names e, which has no binding in scope/);
  });

  it.each([
    ['a statement that is not a declaration', 'f(e);'],
    ['no statement before the return', ''],
  ])('throws when the root sees the member only through %s', (_, before) => {
    const src =
      builders + `function la(e){${before}return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}`;
    expect(() => extractSettingsKeys(src)).toThrow(/names i, which has no binding/);
  });

  it('throws on a member bound by destructuring', () => {
    const src =
      builders + 'function la(e){let {i}=e;return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(() => extractSettingsKeys(src)).toThrow(/names i, which has a destructured binding/);
  });

  it('finds the declaration before the root past a nested one inside it', () => {
    // The nearest `let` belongs to an arrow body inside the statement. Its text up
    // to the `;` does not parse, so the search moves on to the real statement.
    const src =
      builders +
      'function la(e){let r=(d)=>{let q=d;return q},i=u({commit:o()});' +
      'return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(extractSettingsKeys(src).map((k) => k.path)).toContain('attribution.commit');
  });

  it('adds no children for a local declared without an initializer', () => {
    const src =
      builders + 'function la(e){let i;return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(extractSettingsKeys(src).map((k) => k.path)).toEqual(['apiKeyHelper', 'attribution']);
  });

  it("keeps one value's block locals out of another value", () => {
    // `model` declares its own `i`. `attribution` must still read the `i` bound
    // before the root, not the nearer one inside `model`'s thunk.
    const src =
      builders +
      'function la(e){let i=u({commit:o()});return{apiKeyHelper:()=>o(),' +
      'model:()=>{let i=u({x:o()});return o()},attribution:()=>Fe([H(),i])}}';
    expect(extractSettingsKeys(src).map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'model',
      'attribution',
      'attribution.commit',
    ]);
  });

  it("reads a union's own description, not its inline member's", () => {
    const src =
      builders +
      'Q=u({apiKeyHelper:o(),attribution:Fe([H(),u({commit:o().describe("Commit")})]).describe("Own")})';
    const by = new Map(extractSettingsKeys(src).map((k) => [k.path, k.description]));
    expect(by.get('attribution')).toBe('Own');
    expect(by.get('attribution.commit')).toBe('Commit');
  });

  it('throws on a union with two object members', () => {
    const src = builders + 'Q=u({apiKeyHelper:o(),attribution:Fe([u({commit:o()}),u({pr:o()})])})';
    expect(() => extractSettingsKeys(src)).toThrow(/"attribution" has more than one object member/);
  });
});

describe('extractSettingsKeys — lazy schemas (2.1.281 →)', () => {
  // From 2.1.281 `permissions` and `sandbox` are zod `lazy` schemas:
  // `permissions:Oe(()=>ji(e)).describe(…)`. Their keys are the getter's keys.
  const builders =
    'var o=Ct(),u=Ct(),H=Ct();function Fe(e,n){return new Zn(e)}' +
    'function Oe(e){let n;return new Do({type:"lazy",getter:()=>n??=e()})}';

  it("reads the keys of a factory the getter calls, and the lazy call's own description", () => {
    const src =
      builders +
      'function ji(e){return u({allow:o().describe("Allow"),deny:o()})}' +
      'Q=u({apiKeyHelper:o(),permissions:Oe(()=>ji(e)).describe("Perms")})';
    const keys = extractSettingsKeys(src);
    expect(keys.map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'permissions',
      'permissions.allow',
      'permissions.deny',
    ]);
    expect(keys[1]?.description).toBe('Perms');
    expect(keys[2]?.description).toBe('Allow');
  });

  it('reads a local a thunked, block-bodied getter returns', () => {
    const src =
      builders +
      'function la(e){return{apiKeyHelper:()=>o(),' +
      'sandbox:()=>Oe(()=>{let i=u({enabled:H()});return i.optional()})}}';
    expect(extractSettingsKeys(src).map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'sandbox',
      'sandbox.enabled',
    ]);
  });

  it.each([
    ['takes a second argument', 'Zq(()=>o(),"x")'],
    ['takes a parameter', 'Zq((d)=>d)'],
    ['is async', 'Zq(async()=>o())'],
  ])('keeps the plain path for a call whose argument %s', (_, value) => {
    // Not a lazy schema, so the callee is still resolved and judged by its body.
    const src =
      builders + 'function Zq(e){return u({x:o()})}' + `Q=u({apiKeyHelper:o(),k:${value}})`;
    expect(extractSettingsKeys(src).map((k) => k.path)).toEqual(['apiKeyHelper', 'k', 'k.x']);
  });

  it('reads a lazy union member and a factory union member', () => {
    const src =
      builders +
      'function Pz(){return u({commit:o()})}' +
      'Q=u({apiKeyHelper:o(),a:Fe([H(),Oe(()=>Pz())]),b:Fe([H(),Pz()])})';
    expect(extractSettingsKeys(src).map((k) => k.path)).toEqual([
      'apiKeyHelper',
      'a',
      'a.commit',
      'b',
      'b.commit',
    ]);
  });
});

describe('extractSettingsKeys — how a union member local is bound', () => {
  const builders = 'var o=Ct(),u=Ct(),H=Ct();function Fe(e,n){return new Zn(e)}';
  const root = (body: string): string =>
    `${builders}function la(e){${body}return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}`;

  it("reads esbuild's hoisting shape, a bare declaration assigned once", () => {
    expect(extractSettingsKeys(root('var i;i=u({commit:o()});')).map((k) => k.path)).toContain(
      'attribution.commit'
    );
  });

  it.each([
    ['conditionally, as esbuild writes `if`', 'let i=u({commit:o()});e&&(i=u({x:o()}));'],
    ['twice after a bare declaration', 'var i;i=u({commit:o()});i=u({x:o()});'],
    ['inside a nested function', 'let i=u({commit:o()}),r=()=>{i=u({x:o()})};'],
    ['by a destructuring assignment', 'let i=u({commit:o()});[i]=[u({x:o()})];'],
    ['by an update', 'let i=u({commit:o()});i++;'],
    ['by a var in a nested block', 'var i=u({commit:o()});{var i=u({x:o()})}'],
    [
      'in a switch case without a declaration',
      'let i=u({commit:o()});switch(e){case 1:i=u({x:o()})}',
    ],
    [
      'in a switch discriminant, outside the case scope',
      'let i=u({commit:o()});switch(i=u({x:o()})){case 1:let i=o()}',
    ],
    ['through a hole in an array pattern', 'let i=u({commit:o()});[,i]=[0,u({x:o()})];'],
    ['by an object rest', 'let i=u({commit:o()});({...i}=e);'],
    ['by a default in a pattern', 'let i=u({commit:o()});[i=u({x:o()})]=[];'],
    ['by an array rest', 'let i=u({commit:o()});[...i]=[];'],
    ['as a for-of target', 'let i=u({commit:o()});for(i of e);'],
    ['as a for-in target', 'let i=u({commit:o()});for(i in e);'],
  ])('throws on a member assigned again %s', (_, body) => {
    expect(() => extractSettingsKeys(root(body))).toThrow(/names i, which has been reassigned/);
  });

  it.each([
    ['a property write', 'let i=u({commit:o()});e.i=o();'],
    ['an object pattern key', 'let i=u({commit:o()}),q;({i:q}=e);'],
    ['a nested function parameter', 'let i=u({commit:o()}),r=(i)=>{i=o()};'],
    ['a nested function var', 'let i=u({commit:o()});e&&function(){var i=u({x:o()})};'],
    ['a block let', 'let i=u({commit:o()});{let i=o();i=H()}'],
    ['a loop counter', 'let i=u({commit:o()});for(let i=0;i<1;i++);'],
    ['a catch parameter', 'let i=u({commit:o()});try{f()}catch(i){i=o()}'],
    ['an arrow parameter with an expression body', 'let i=u({commit:o()}),r=(i)=>i=o();'],
    ['a block function declaration', 'let i=u({commit:o()});{function i(){}i=o()}'],
    ['a block class declaration', 'let i=u({commit:o()});{class i{}i=o()}'],
    [
      'a var in a function nested in a function',
      'let i=u({commit:o()}),r=()=>{(()=>{var i=o()})()};',
    ],
    ['a for-in let', 'let i=u({commit:o()});for(let i in e)i=o();'],
    ['a loop with no head', 'let i=u({commit:o()});for(;;)break;'],
    ['a let in a switch case', 'let i=u({commit:o()});switch(e){case 1:let i=o();i=H()}'],
    ['a named function expression', 'let i=u({commit:o()}),r=function i(){i=o()};'],
    ['a named class expression', 'let i=u({commit:o()}),C=class i{m(){i=o()}};'],
    ['a class static block var', 'let i=u({commit:o()});class K{static{var i=o();i=H()}}'],
  ])('does not count %s as a write to the member', (_, body) => {
    expect(extractSettingsKeys(root(body)).map((k) => k.path)).toContain('attribution.commit');
  });

  it('throws on a binding cycle', () => {
    const src =
      builders + 'function la(e){let i=j,j=i;return u({apiKeyHelper:o(),attribution:Fe([H(),i])})}';
    expect(() => extractSettingsKeys(src)).toThrow(/names [ij], which has a binding cycle/);
  });
});

describe('extractSettingsKeys — a misread value extent', () => {
  it('throws when a regex holding a bracket moves the end of a value', () => {
    // scanLevel counts the `(` inside `/\(/`, so without the check the value runs
    // on, `model` and `x` are swallowed into `apiKeyHelper`, and they vanish.
    const src = 'Q=v.object({apiKeyHelper:v.string().regex(/\\(/),model:v.string(),x:v.string()})';
    expect(() => extractSettingsKeys(src)).toThrow(/"apiKeyHelper" is not one expression/);
  });

  it('throws when a quote inside a regex starts a false string', () => {
    const src = 'Q=v.object({apiKeyHelper:v.string().regex(/"/),model:v.string()})';
    expect(() => extractSettingsKeys(src)).toThrow(/is not one expression/);
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
  it('refuses the value rather than reading past it', () => {
    // Truncated mid-object: the brace never arrives before end-of-source, so the
    // value is not one expression. Walking it would hand the parent whatever
    // `.describe()` lies past the value, a description of an unrelated key.
    const src =
      'Q=v.object({apiKeyHelper:v.string(),broken:v.object({a:v.string().describe("Child")';
    expect(() => extractSettingsKeys(src)).toThrow(/"broken" is not one expression/);
  });
});
