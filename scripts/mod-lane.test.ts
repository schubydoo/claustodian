// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { extractControlMessages } from './control-lane.js';
import {
  MOD_METHOD_FLOOR,
  extractControlAndModMethods,
  extractModEvidence,
  extractModMethods,
} from './mod-lane.js';

/**
 * The dispatch table as the real bundle writes it: each key is a method name, and
 * most values are `{check, run}` objects. Later releases point many entries at a
 * handler built elsewhere, so the fixture mixes in an identifier and a call too.
 * Identifiers are meaningless on purpose — the bundle renames them every release.
 */
const ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['ui.toast', '{check:(n)=>n,run:q("ui.toast",X)}'],
  ['ui.status', '{check:(n)=>n,run:(n)=>n}'],
  ['fs.read2', '{run:(n)=>n}'],
  ['ui.notice', 'J'],
  ['http.fetch', 'W("http.fetch")'],
  ['fs.write', '{check:(n)=>n,run:(n)=>n}'],
  ['store.get', '{run:(n)=>n}'],
  ['store.set', '{run:(n)=>n}'],
  ['clock.now', '{run:(n)=>n}'],
  ['env.get', '{check:(n)=>n,run:(n)=>n}'],
  ['tool.list', '{run:(n)=>n}'],
  ['command.run', 'K'],
];
const objectOf = (entries: ReadonlyArray<readonly [string, string]>) =>
  `{${entries.map(([key, value]) => `"${key}":${value}`).join(',')}}`;
const TABLE = `var T=${objectOf(ENTRIES)};`;
const METHODS = ENTRIES.map(([key]) => `$.${key}`).sort();

/**
 * A miniature control protocol that passes every control-lane floor (a routed
 * union, both directional sub-unions, a dispatcher), copied from the scrape-binary
 * fixture. It lets a test at MOD_METHOD_FLOOR reach the mod lane at all.
 */
const CONTROL = [
  `var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;`,
  `var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes the session."));`,
  `var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the active model."));`,
  `var B1=Ee(()=>Se({subtype:xt("hook_callback")}).describe("Delivers a hook callback."));`,
  `var B2=Ee(()=>Se({subtype:xt("can_use_tool")}).describe("Asks whether a tool may run."));`,
  `var HOST=Ee(()=>fs([A1(),A2()]).describe("Control requests a client sends to drive the loop."));`,
  `var CLI=Ee(()=>fs([B1(),B2()]).describe("Control requests the agent loop originates and needs a reply to."));`,
  `var ALL=Ee(()=>fs([A1(),A2(),B1(),B2()]));`,
  `function handle(e){` +
    `if(e.request.subtype==="initialize")return 1;` +
    `else if(e.request.subtype==="set_model")return 2;` +
    `else if(e.request.subtype==="hook_callback")return 3;` +
    `else if(e.request.subtype==="can_use_tool")return 4;` +
    `return 0}`,
].join('');

describe('extractModMethods', () => {
  it('reads every key of the dispatch table as a $.-prefixed method, sorted', () => {
    expect(extractModMethods(TABLE, '2.1.300')).toEqual(METHODS);
    expect(METHODS).toContain('$.fs.read2');
    expect(METHODS).toContain('$.ui.notice');
  });

  it('finds the table in whichever chunk holds it', () => {
    expect(extractModMethods(['var a=1;', TABLE], '2.1.300')).toEqual(METHODS);
  });

  it('ignores a dotted-key object whose values are mostly not run handlers', () => {
    // The event tables share the key shape but hold bare handlers, never `{run}`.
    const events = `var E=${objectOf(ENTRIES.map(([key], i) => [key, i < 3 ? '{run:1}' : '(e)=>e'] as const))};`;
    expect(extractModMethods([events, TABLE], '2.1.300')).toEqual(METHODS);
  });

  it('ignores a small run-shaped object, such as a single handler registration', () => {
    // 2.1.300 registers core handlers as `{"prompt.compose":{name:"core",run:…}}`,
    // which has the table's shape at one key.
    const registration = 'var R={core:{"prompt.compose":{name:"core",run:(s)=>s}}};';
    expect(extractModMethods([registration, TABLE], '2.1.300')).toEqual(METHODS);
  });

  it('refuses a computed key or a template-literal key inside the table', () => {
    // A method the rule cannot read must stop the run: skipped silently, it would
    // publish as a removal, because absence from the table is removal evidence.
    for (const extra of ['["ui.computed"]:{run:1}', '[`ui.tpl`]:{run:1}', '"ui.a.b":{run:1}']) {
      const odd = TABLE.replace('};', `,${extra}};`);
      expect(() => extractModMethods(odd, '2.1.300')).toThrow(/^mod lane: .*cannot read/);
    }
  });

  it('refuses a spread inside the table', () => {
    const spread = TABLE.replace('};', ',...core};');
    expect(() => extractModMethods(spread, '2.1.300')).toThrow(/^mod lane: .*cannot read/);
  });

  it('refuses two tables, because the rule can no longer tell which is the API', () => {
    expect(() => extractModMethods([TABLE, TABLE.replace('var T', 'var U')], '2.1.300')).toThrow(
      /^mod lane: .*2 tables/
    );
  });

  it('refuses a release at or after the floor with no table', () => {
    expect(() => extractModMethods('var a=1;', MOD_METHOD_FLOOR)).toThrow(/^mod lane: /);
  });

  it('reports nothing for a release before the floor with no table', () => {
    expect(extractModMethods('var a=1;', '2.1.241')).toEqual([]);
  });
});

describe('extractModEvidence', () => {
  it('reports a method name that is quoted outside the table as a mention', () => {
    // `ui.resolve` left the table at 2.1.267 and is still quoted in every later
    // bundle: it moved, it was not removed. A mention is what keeps it live.
    const source = [TABLE, 'x("ui.resolve");', 'y(`ui.gone`);', 'z("other.thing");'];
    expect(extractModEvidence(source, '2.1.300')).toEqual({
      methods: METHODS,
      mentions: ['$.ui.gone', '$.ui.resolve'],
    });
  });

  it('does not count a table key as a mention of itself', () => {
    expect(extractModEvidence([TABLE, 'x("ui.toast");'], '2.1.300').mentions).toEqual([]);
  });

  it('reports no mentions before the floor, where there is no table to scope them', () => {
    expect(extractModEvidence('x("ui.resolve");', '2.1.241')).toEqual({
      methods: [],
      mentions: [],
    });
  });
});

describe('extractControlAndModMethods', () => {
  it('returns both lanes from one call', () => {
    const { controlMessages, modMethods } = extractControlAndModMethods(
      ['var a=1;', TABLE],
      '0.2.0'
    );
    expect(controlMessages).toEqual([]);
    expect(modMethods).toEqual(METHODS);
  });

  it('applies the mod lane floor to the shared parse', () => {
    // CONTROL passes every control-lane floor at 2.1.242, so only the mod lane can
    // refuse here — a bare `var a=1;` would be refused by the control lane first.
    expect(() => extractControlAndModMethods(CONTROL, '0.2.0')).not.toThrow();
    expect(() => extractControlAndModMethods([CONTROL], MOD_METHOD_FLOOR)).toThrow(/^mod lane: /);
    const both = extractControlAndModMethods([CONTROL, TABLE], MOD_METHOD_FLOOR);
    expect(both.controlMessages).not.toEqual([]);
    expect(both.modMethods).toEqual(METHODS);
  });
});

describe('extractControlMessages onProgram', () => {
  it('hands each parsed chunk to the callback once, so a second lane need not parse', () => {
    const seen: unknown[] = [];
    // Below the dispatch floor the control lane yields nothing and throws nothing.
    extractControlMessages(['var a=1;', 'var b=2;'], '0.2.0', (program) => seen.push(program));
    expect(seen).toHaveLength(2);
    expect(seen.every((p) => (p as { type: string }).type === 'Program')).toBe(true);
  });
});
