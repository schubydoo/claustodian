// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  CONTROL_DISPATCH_FLOOR,
  CONTROL_SPLIT_FLOOR,
  CONTROL_UNION_FLOOR,
  controlMessageConfidence,
  extractControlMessages,
  type ControlMessageObservation,
} from './control-lane.js';

/**
 * A synthetic bundle exercising every shape the real one uses. Written out in
 * full rather than assembled from helpers: these tests exist to pin the exact
 * source constructs, so an edit that changes a construct should read as a
 * change to the fixture, not to a builder's arguments.
 *
 * Builder identifiers are deliberately meaningless (`Se`, `xt`, `fs`) — the
 * real bundle renames them every few releases, and nothing here may anchor on
 * a name.
 */
function bundle(parts: {
  split?: boolean;
  callSite?: boolean;
  dispatch?: boolean;
  contaminants?: boolean;
}): string {
  const { split = true, callSite = true, dispatch = true, contaminants = true } = parts;
  const lines: string[] = [
    'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a,$r=(a)=>a,Ce=(s)=>s,$=()=>0;',
    'var A1=Ee(()=>Se({subtype:xt("initialize"),x:$()}).describe("Initializes the SDK session with hooks, MCP servers, and agent configuration."));',
    'var A2=Ee(()=>Se({subtype:xt("set_model"),x:$()}).describe("Sets the active model."));',
    'var B1=Ee(()=>Se({subtype:xt("hook_callback"),x:$()}).describe("Delivers a hook callback with its input data."));',
    'var B2=Ee(()=>Se({subtype:xt("can_use_tool"),x:$()}));',
    'var ALL=Ee(()=>fs([A1(),A2(),B1(),B2()]).describe("Every control request."));',
  ];
  if (split) {
    lines.push(
      'var CLI=Ee(()=>fs([B1(),B2()]).describe("Control requests the agent loop originates and needs a reply to."));',
      'var HOST=Ee(()=>fs([A1(),A2()]).describe("Control requests a client sends to drive the loop."));'
    );
  }
  if (callSite) {
    lines.push(
      'class K{go(e,t){return this.request({subtype:"remote_control",enabled:e,name:t})}}'
    );
  }
  if (dispatch) {
    // The CLI's control-request handler. This is what proves family membership:
    // real bundles route every control request through `<expr>.request.subtype`,
    // and route no other family through it.
    lines.push(
      'function h(e){' +
        'if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;' +
        'else if(e.request.subtype==="hook_callback")return 3;' +
        'else if(e.request.subtype==="can_use_tool")return 4;' +
        'else if(e.request.subtype==="remote_control")return 5;' +
        'else if(e.request.subtype==="add_directory")return 6;' +
        'return 0}'
    );
  }
  if (contaminants) {
    lines.push(
      // result-message family: subtype as an ENUM, never an individual literal
      'var R=Ee(()=>Se({type:xt("result"),subtype:$r(["error_during_execution","error_max_turns","error_max_budget_usd"])}));',
      // telemetry payload — reuses the `subtype` key but never touches the wire
      'O("tengu_sdk_result",{subtype:Ce("terminated"),is_error:!0,duration_ms:1});',
      // system message family
      'q({type:"system",subtype:"api_error",message:"boom"});',
      // ...and its handler, which routes on a plain `.subtype`, not `.request.subtype`
      'function sys(m){if(m.subtype==="api_error")return 1;return 0}',
      // a call site that is NOT a control request: constructed, never routed
      'function log(){return emit({subtype:"away_summary",text:"x"})}',
      // dynamic forward — a re-emission, not a declaration
      'function fwd(m){return this.request({subtype:m.subtype,payload:m})}'
    );
  }
  return lines.join('\n');
}

const bySymbol = (found: ControlMessageObservation[]) =>
  new Map(found.map((o) => [o.symbol, o] as const));

describe('extractControlMessages', () => {
  it('publishes a subtype that has no schema at all, from its call site', () => {
    // The regression that matters most: `remote_control` carries no zod schema in
    // any build examined, yet it is among the most user-visible subtypes on the
    // wire. A schema-only extractor emits nothing here.
    const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

    const remote = found.get('remote_control');
    expect(remote).toBeDefined();
    expect(remote?.evidence).toBe('call_site');
    expect(controlMessageConfidence(remote!)).toBe('medium');
  });

  it('publishes a subtype the CLI only ever handles, from its dispatch comparison', () => {
    const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

    const added = found.get('add_directory');
    expect(added).toBeDefined();
    expect(added?.evidence).toBe('dispatch');
    expect(controlMessageConfidence(added!)).toBe('low');
  });

  it('excludes the result-message family, whose subtypes exist only inside an enum', () => {
    const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

    for (const name of ['error_during_execution', 'error_max_turns', 'error_max_budget_usd']) {
      expect(found.has(name)).toBe(false);
    }
  });

  it('excludes telemetry payloads, which reuse the subtype key but never reach the wire', () => {
    // `terminated` is indistinguishable from a real subtype by shape alone. It is
    // excluded because its enclosing call is an analytics emit, not because it
    // looks different.
    const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

    expect(found.has('terminated')).toBe(false);
  });

  it('excludes the system-message family', () => {
    const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

    expect(found.has('api_error')).toBe(false);
  });

  it('does not admit a subtype the CLI constructs but never routes as a request', () => {
    // Membership is positive: being built somewhere is not being a control
    // request. `away_summary` has a call site and no handler on the request path.
    const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

    expect(found.has('away_summary')).toBe(false);
  });

  it('ignores a dynamic subtype forward, which re-emits rather than declares', () => {
    const symbols = extractControlMessages(bundle({}), '2.1.226').map((o) => o.symbol);

    expect(symbols).not.toContain('m');
    expect(symbols).not.toContain('subtype');
  });

  describe('direction', () => {
    it('reads each side from the union that declares it', () => {
      const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

      // "a client sends to drive the loop"
      expect(found.get('initialize')?.direction).toBe('host_to_cli');
      expect(found.get('set_model')?.direction).toBe('host_to_cli');
      // "the agent loop originates"
      expect(found.get('hook_callback')?.direction).toBe('cli_to_host');
      expect(found.get('can_use_tool')?.direction).toBe('cli_to_host');
    });

    it('is null before the split exists, and is never backfilled', () => {
      // The same symbols, from a bundle whose unions are not yet split by
      // direction. Nothing may borrow the later answer.
      const found = bySymbol(extractControlMessages(bundle({ split: false }), '2.1.132'));

      expect(found.get('initialize')?.direction).toBeNull();
      expect(found.get('hook_callback')?.direction).toBeNull();
    });

    it('is null for a subtype that belongs to no union', () => {
      // `this.request(...)` is outbound from whichever side owns `this`, and the
      // bundle ships both sides. A call site cannot name a direction.
      const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

      expect(found.get('remote_control')?.direction).toBeNull();
      expect(found.get('add_directory')?.direction).toBeNull();
    });
  });

  describe('descriptions', () => {
    it('takes only the schema object’s own describe()', () => {
      const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

      expect(found.get('initialize')?.description).toBe(
        'Initializes the SDK session with hooks, MCP servers, and agent configuration.'
      );
      // `can_use_tool` has no describe() of its own and is followed by a union
      // that does. Pairing with the next describe() found would steal it.
      expect(found.get('can_use_tool')?.description).toBe('');
    });

    it('grades confidence by evidence, not by presence alone', () => {
      const found = bySymbol(extractControlMessages(bundle({}), '2.1.226'));

      expect(controlMessageConfidence(found.get('initialize')!)).toBe('high');
      expect(controlMessageConfidence(found.get('can_use_tool')!)).toBe('medium');
    });
  });

  describe('circuit breaker', () => {
    it('throws when a version at or above the union floor yields nothing', () => {
      // A zeroed union is indistinguishable from a mass removal downstream. The
      // lane must fail loudly rather than emit an empty set.
      expect(() => extractControlMessages('var x=1;', '2.1.226')).toThrow(/no control_request/i);
    });

    it('throws on an empty result in the dispatch era, which dates the whole surface', () => {
      // Every other guard is gated at or above a floor, which left 1.0.45 up to the
      // union floor unguarded — the one era that can date the surface correctly.
      expect(() => extractControlMessages('var x=1;', '2.1.20')).toThrow(/dispatch floor/i);
    });

    it('returns empty below the dispatch floor, where absence is expected', () => {
      expect(extractControlMessages('var x=1;', '1.0.44')).toEqual([]);
    });

    it('throws on source it cannot parse, rather than reporting zero symbols', () => {
      expect(() => extractControlMessages('function (){', '2.1.226')).toThrow(/parse/i);
    });
  });

  describe('floors', () => {
    it('pins the three floors this lane depends on', () => {
      // All three are measured, not chosen, and each was checked against real
      // bundles: 1.0.44 yields 0 symbols and 1.0.45 yields 1; 2.1.62 has no routed
      // union and 2.1.63 has one; 2.1.132 is undirected and 2.1.133 is split.
      //
      // ⚠️ The union floor is NOT the first union array of subtype schemas — that
      // is 2.1.30, and setting this constant to it made every release from 2.1.30
      // to 2.1.62 throw, because those unions are not routed as control requests.
      // Do not "correct" 2.1.63 back to 2.1.30.
      expect(CONTROL_DISPATCH_FLOOR).toBe('1.0.45');
      expect(CONTROL_UNION_FLOOR).toBe('2.1.63');
      expect(CONTROL_SPLIT_FLOOR).toBe('2.1.133');
    });
  });

  describe('binding forms', () => {
    // The real bundle lazy-inits by ASSIGNMENT (`X = Ee(() => ...)`), not by
    // declarator. Indexing only declarator inits silently loses every schema, and
    // with them every union — so direction goes null across the board while the
    // symbol count still looks plausible.
    const assigned = [
      'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
      'var A1,A2,B1,B2,HOST,CLI;',
      'A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes the SDK session."));',
      'A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the active model."));',
      'B1=Ee(()=>Se({subtype:xt("hook_callback")}).describe("Delivers a hook callback."));',
      'B2=Ee(()=>Se({subtype:xt("can_use_tool")}).describe("Asks for permission."));',
      'HOST=Ee(()=>fs([A1(),A2()]).describe("Control requests a client sends to drive the loop."));',
      'CLI=Ee(()=>fs([B1(),B2()]).describe("Control requests the agent loop originates and needs a reply to."));',
      'function h(e){' +
        'if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;' +
        'else if(e.request.subtype==="hook_callback")return 3;' +
        'else if(e.request.subtype==="can_use_tool")return 4;' +
        'return 0}',
    ].join('\n');

    it('binds a schema assigned rather than declared, so its union still resolves', () => {
      const found = bySymbol(extractControlMessages(assigned, '2.1.226'));

      expect(found.size).toBe(4);
      expect(found.get('initialize')?.direction).toBe('host_to_cli');
      expect(found.get('hook_callback')?.direction).toBe('cli_to_host');
    });

    // The fixtures below carry no directional union, so they are versioned at
    // 2.1.132 — below CONTROL_SPLIT_FLOOR, where a null direction is the honest
    // answer. At or above the floor the lane refuses that state outright; see the
    // guard tests.
    it('reads a quoted or computed property key', () => {
      // Minifiers quote a key when they feel like it, and a computed key must not
      // throw on the way past.
      const quoted = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a,k="x";',
        'var A1=Ee(()=>Se({[k]:1,"subtype":xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({"subtype":xt("set_model")}));',
        'var ALL=Ee(()=>fs([A1(),A2()]));',
        'function h(e){' +
          'if(e.request.subtype==="initialize")return 1;' +
          'else if(e.request.subtype==="set_model")return 2;' +
          'return 0}',
      ].join('\n');
      const found = bySymbol(extractControlMessages(quoted, '2.1.132'));

      expect(found.has('initialize')).toBe(true);
      expect(found.get('initialize')?.description).toBe('Initializes.');
      expect(found.has('set_model')).toBe(true);
    });
  });

  describe('shapes it must tolerate without leaking or throwing', () => {
    // Minified output is not tidy. Every construct below appears in real bundles or
    // is one refactor away from appearing: object spread, sparse arrays, schemas
    // bound to a member rather than a name, unions with no description. The
    // extractor has to walk past all of them and still admit exactly the two
    // subtypes the CLI actually routes.
    const messy = [
      'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a,other="zzz",obj={};',
      'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes the session."));',
      'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the active model."));',
      // union shapes: no describe, bare identifiers, a hole, empty, non-string describe
      'var ALL=Ee(()=>fs([A1(),A2()]));',
      'var BARE=Ee(()=>fs([A1,A2]));',
      'var HOLE=Ee(()=>fs([,A1()]));',
      'var EMPTY=Ee(()=>fs([]));',
      'var NUMDESC=Ee(()=>fs([A1(),A2()]).describe(1));',
      // object shapes: spread sibling, numeric key, plain object with no subtype
      'q({...other,subtype:"initialize"});',
      'q({0:1,subtype:"set_model"});',
      'var plain={a:1};',
      // builder arity that proves nothing — must yield no symbol at all
      'var W1=Ee(()=>Se({subtype:xt("a","b")}));',
      'var W2=Ee(()=>Se({subtype:xt()}));',
      // wrappers that are not a describe() call
      'var RAW={subtype:xt("initialize")};',
      'var OPT=Ee(()=>Se({subtype:xt("set_model")}).optional());',
      'var DREF=Se({subtype:xt("initialize")}).describe;',
      'var DNUM=Ee(()=>Se({subtype:xt("set_model")}).describe(2));',
      // bindings that resolve to no name
      'var {z}=Ee(()=>Se({subtype:xt("initialize")}));',
      'obj.x=Ee(()=>Se({subtype:xt("set_model")}));',
      // dispatch: loose equality, a non-literal operand, and an unrelated member
      'function h(e){' +
        'if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype=="set_model")return 2;' +
        'else if(e.request.subtype===other)return 3;' +
        'else if(e.other==="zzz")return 4;' +
        'return 0}',
    ].join('\n');

    it('admits exactly the routed subtypes and nothing the odd shapes carry', () => {
      const found = bySymbol(extractControlMessages(messy, '2.1.132'));

      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
    });

    it('keeps the right description when the same subtype appears in many shapes', () => {
      const found = bySymbol(extractControlMessages(messy, '2.1.132'));

      expect(found.get('initialize')?.description).toBe('Initializes the session.');
      expect(found.get('set_model')?.description).toBe('Sets the active model.');
    });

    it('recognises a loose-equality dispatch as routing', () => {
      // `==` and `===` are both minifier output; only one was exercised before.
      const found = bySymbol(extractControlMessages(messy, '2.1.132'));

      expect(found.has('set_model')).toBe(true);
    });

    it('reads a dispatch written with the literal on the left', () => {
      // `"x" === e.request.subtype` is the same routing, operands reversed.
      const yoda = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var ALL=Ee(()=>fs([A1(),A2()]));',
        'function h(e){' +
          'if("initialize"===e.request.subtype)return 1;' +
          'else if("set_model"===e.request.subtype)return 2;' +
          'return 0}',
      ].join('\n');
      const found = bySymbol(extractControlMessages(yoda, '2.1.132'));

      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
    });

    it('walks past union arrays that are not consumed by a describe() call', () => {
      // A union array reached a `.describe()` in every fixture so far. These three
      // consumers are all legal minifier output and none carries a description.
      const undescribed = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var LOOSE=[A1(),A2()];',
        'var OPT=Ee(()=>fs([A1(),A2()]).optional());',
        'var DREF=fs([A1(),A2()]).describe;',
        'function h(e){' +
          'if(e.request.subtype==="initialize")return 1;' +
          'else if(e.request.subtype==="set_model")return 2;' +
          'return 0}',
      ].join('\n');
      const found = bySymbol(extractControlMessages(undescribed, '2.1.132'));

      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
      expect(found.get('initialize')?.direction).toBeNull();
    });

    it('assigns no direction when no union carries a directional description', () => {
      const found = bySymbol(extractControlMessages(messy, '2.1.132'));

      expect(found.get('initialize')?.direction).toBeNull();
      expect(found.get('set_model')?.direction).toBeNull();
    });

    it('leaves a schema unbound when no binding site is in reach of the walk', () => {
      // A schema built inline under a deep call chain has no binding of its own.
      // The walk is bounded; running out of hops must leave the schema unbound
      // rather than latch onto whatever encloses the whole expression.
      const deep = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var ALL=Ee(()=>fs([A1(),A2()]));',
        'w1(w2(w3(w4(w5(w6(w7(w8(w9(w10(w11(Se({subtype:xt("hook_callback")}))))))))))));',
        'function h(e){' +
          'if(e.request.subtype==="initialize")return 1;' +
          'else if(e.request.subtype==="set_model")return 2;' +
          'return 0}',
      ].join('\n');
      const found = bySymbol(extractControlMessages(deep, '2.1.132'));

      // hook_callback is declared but never routed, so an unbound schema is all
      // it has — and that admits nothing.
      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
    });

    it('lets no unrouted union vote a direction, whatever its prose claims', () => {
      // A system-message union whose describe() happens to contain a direction
      // anchor. Its members are not routed as control requests, so it owns no
      // vote — even over a routed subtype it drags in as a minority member.
      const src = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var N1=Ee(()=>Se({subtype:xt("status")}));',
        'var N2=Ee(()=>Se({subtype:xt("away_summary")}));',
        'var ALL=Ee(()=>fs([A1(),A2()]));',
        'var SYS=Ee(()=>fs([N1(),N2(),A1()]).describe(' +
          '"Control requests the agent loop originates and needs a reply to."));',
        'function h(e){' +
          'if(e.request.subtype==="initialize")return 1;' +
          'else if(e.request.subtype==="set_model")return 2;' +
          'return 0}',
      ].join('\n');
      const found = bySymbol(extractControlMessages(src, '2.1.132'));

      expect(found.get('initialize')?.direction).toBeNull();
      expect(found.has('status')).toBe(false);
      expect(found.has('away_summary')).toBe(false);
    });
  });

  describe('each failure mode has its own guard', () => {
    // `belongs` is a union of two independent signals, so a final-count check
    // alone fires only when BOTH die in the same release. Either dying alone
    // publishes a plausible-looking set that is quietly wrong.
    const routed =
      'function h(e){' +
      'if(e.request.subtype==="initialize")return 1;' +
      'else if(e.request.subtype==="set_model")return 2;' +
      'return 0}';

    it('throws when the union shape is gone but dispatch survives', () => {
      // The realistic version of this is a `union([...])` → `discriminatedUnion`
      // refactor: the array becomes an object map, every call-site-only subtype
      // disappears (`remote_control` among them) and every direction nulls — while
      // the symbol count still looks entirely plausible.
      expect(() => extractControlMessages(routed, '2.1.226')).toThrow(/no control_request union/i);
    });

    it('throws when only ONE side of the split is reworded', () => {
      // Each side comes from its own anchor phrase. A count check passes here,
      // because the surviving side keeps the map non-empty — while every subtype in
      // the reworded union publishes null.
      const halfReworded = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var B1=Ee(()=>Se({subtype:xt("hook_callback")}).describe("Hook callback."));',
        'var B2=Ee(()=>Se({subtype:xt("can_use_tool")}).describe("Permission."));',
        'var HOST=Ee(()=>fs([A1(),A2()]).describe("Control requests a client sends to drive the loop."));',
        'var CLI=Ee(()=>fs([B1(),B2()]).describe("Requests the loop makes, reworded."));',
        'function h(e){' +
          'if(e.request.subtype==="initialize")return 1;' +
          'else if(e.request.subtype==="set_model")return 2;' +
          'else if(e.request.subtype==="hook_callback")return 3;' +
          'else if(e.request.subtype==="can_use_tool")return 4;' +
          'return 0}',
      ].join('\n');

      expect(() => extractControlMessages(halfReworded, '2.1.226')).toThrow(
        /no cli_to_host union/i
      );
    });

    it('throws when the union survives but the direction prose is gone', () => {
      // The anchors are English text in a `.describe()`. A rewording nulls every
      // direction, and null is indistinguishable from the null a call-site-only
      // subtype legitimately carries — so the loss leaves no trace in the output.
      const reworded = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var ALL=Ee(()=>fs([A1(),A2()]).describe("Requests, reworded beyond recognition."));',
        routed,
      ].join('\n');

      expect(() => extractControlMessages(reworded, '2.1.226')).toThrow(
        /no host_to_cli and no cli_to_host union/i
      );
      // Below the floor the very same bundle is fine: null is the honest answer there.
      expect(extractControlMessages(reworded, '2.1.132')).toHaveLength(2);
    });

    it('refuses when two unions claim opposite directions for one subtype', () => {
      // Last-wins would decide the published direction by AST order — a property
      // of the minifier, not the protocol, so it could flip between adjacent
      // releases with no protocol change at all.
      const conflicting = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var HOST=Ee(()=>fs([A1(),A2()]).describe("Control requests a client sends to drive the loop."));',
        'var CLI=Ee(()=>fs([A1(),A2()]).describe("Control requests the agent loop originates and needs a reply to."));',
        routed,
      ].join('\n');

      expect(() => extractControlMessages(conflicting, '2.1.226')).toThrow(/claimed by both/i);
    });

    it('does not bind a schema to an enclosing declarator it does not belong to', () => {
      // The walk must STOP at a binding site whose name it cannot read. Falling
      // through a destructuring declarator lets the schema bind to `OUTER`, and any
      // array holding `OUTER` then reads as a union containing that subtype.
      const nested = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a,wrap=(f)=>f;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var ALL=Ee(()=>fs([A1(),A2()]));',
        'var OUTER=wrap(function(){var {z}=Ee(()=>Se({subtype:xt("hook_callback")}));});',
        // THREE members, two of them routed. With only [OUTER, A1()] the union is
        // 1-of-2 routed either way, so the majority rule discards it whether or not
        // OUTER wrongly binds — and the test passes with and without its fix.
        'var SPURIOUS=Ee(()=>fs([OUTER,A1(),A2()]));',
        routed,
      ].join('\n');
      const found = bySymbol(extractControlMessages(nested, '2.1.132'));

      // hook_callback is never routed on the request path here, so it must not be
      // admitted — and OUTER must not have inherited its name.
      expect(found.has('hook_callback')).toBe(false);
      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
    });
  });

  describe('admittedBy', () => {
    it('separates a union-only admission from a dispatched one, at the same evidence grade', () => {
      // The case this field exists for, modelling 2.1.63 — the release where the
      // union becomes provable and `hook_callback` is published for the FIRST time.
      // That is the version whose record carries the flag, so it is the state to
      // pin. Its 2.1.62 shape is this same bundle with the union unrouted, where the
      // extractor yields no `hook_callback` at all; there is nothing to assert there,
      // and that absence is precisely why the 2.1.63 date is an upper bound.
      //
      // Measured against the real bundles, not inferred: 2.1.62 publishes 16 symbols,
      // every one `dispatch`; 2.1.63 publishes 20, as 14 `both`, 2 `union` and 4
      // `dispatch`, and `hook_callback` is one of the two `union` records — carrying
      // "Delivers a hook callback with its input data.", so it grades `high` there,
      // which is the grade the record contract forbids flagging as estimated.
      //
      // Here it is a member of a routed union and is NOT itself on the request path.
      // It carries a described schema, so `evidence` is 'schema' and the confidence
      // grade is `high`, identical to `initialize` beside it. Only `admittedBy`
      // separates them.
      const src = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,fs=(a)=>a;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var B1=Ee(()=>Se({subtype:xt("hook_callback")}).describe("Delivers a hook callback."));',
        // THREE members, two of them routed: 2*2 > 3 carries the majority rule, so
        // the union is classified as control requests and admits all three. With
        // only the two routed members the union would admit nothing new and the
        // union-only case would not arise.
        'var ALL=Ee(()=>fs([A1(),A2(),B1()]));',
        // Routes the other two, plus one subtype that is in no union at all.
        'function h(e){' +
          'if(e.request.subtype==="initialize")return 1;' +
          'else if(e.request.subtype==="set_model")return 2;' +
          'else if(e.request.subtype==="add_directory")return 3;' +
          'return 0}',
      ].join('\n');
      const found = bySymbol(extractControlMessages(src, '2.1.132'));

      // Union only — declared, never routed. The upper-bound case.
      expect(found.get('hook_callback')?.admittedBy).toBe('union');
      // Dispatch only — routed, in no union.
      expect(found.get('add_directory')?.admittedBy).toBe('dispatch');
      // Both signals.
      expect(found.get('initialize')?.admittedBy).toBe('both');

      // And the point: neither `evidence` nor the confidence grade tells them
      // apart, so a consumer reading only those publishes the same record for a
      // sound date and an upper bound.
      const hook = found.get('hook_callback')!;
      const init = found.get('initialize')!;
      expect(hook.evidence).toBe('schema');
      expect(init.evidence).toBe('schema');
      expect(controlMessageConfidence(hook)).toBe('high');
      expect(controlMessageConfidence(init)).toBe('high');
    });
  });

  describe('code-split era (2.1.242+, Bun 1.4 ESM output)', () => {
    // From 2.1.242 the CLI is ~1372 ESM chunks that import each other by
    // `/$bunfs/root/chunk-*.js`, so the three things this lane links — a schema, the
    // union that references it, and the dispatch that routes it — land in DIFFERENT
    // chunks. The lane resolves across them by export name, never by concatenating:
    // chunks reuse minified local names, so a flat join would collide definitions.
    //
    // These three chunks model exactly that. The schemas are defined and exported
    // under aliases in one chunk; the unions import them under fresh locals in a
    // second; the dispatch handler and a call-site-only subtype are in a third — and
    // that third chunk rebinds `A1` to an unrelated value, the collision a flat join
    // would get wrong.
    const schemasChunk = [
      'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,$=()=>0;',
      'var A1=Ee(()=>Se({subtype:xt("initialize"),x:$()}).describe("Initializes the SDK session."));',
      'var A2=Ee(()=>Se({subtype:xt("set_model"),x:$()}).describe("Sets the active model."));',
      'var B1=Ee(()=>Se({subtype:xt("hook_callback"),x:$()}).describe("Delivers a hook callback."));',
      'var B2=Ee(()=>Se({subtype:xt("can_use_tool"),x:$()}));',
      'export{A1 as e0,A2 as e1,B1 as e2,B2 as e3};',
    ].join('\n');
    const unionsChunk = [
      'import{e0 as p,e1 as q,e2 as r,e3 as s}from"/$bunfs/root/chunk-schemas.js";',
      'var Ee=(f)=>f,fs=(a)=>a;',
      'var CLI=Ee(()=>fs([r(),s()]).describe("Control requests the agent loop originates and needs a reply to."));',
      'var HOST=Ee(()=>fs([p(),q()]).describe("Control requests a client sends to drive the loop."));',
    ].join('\n');
    const dispatchChunk = [
      // Same NAME as the schema chunk's local, a number here — a per-chunk scope must
      // keep the two apart, which is exactly what a flat concatenation cannot.
      'var A1=123;',
      'class K{go(e,t){return this.request({subtype:"remote_control",enabled:e,name:t})}}',
      'function h(e){' +
        'if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;' +
        'else if(e.request.subtype==="hook_callback")return 3;' +
        'else if(e.request.subtype==="can_use_tool")return 4;' +
        'else if(e.request.subtype==="remote_control")return 5;' +
        'else if(e.request.subtype==="add_directory")return 6;' +
        'return 0}',
    ].join('\n');

    it('resolves a union in one chunk against a schema imported from another', () => {
      const found = bySymbol(
        extractControlMessages([schemasChunk, unionsChunk, dispatchChunk], '2.1.245')
      );

      expect([...found.keys()].sort()).toEqual([
        'add_directory',
        'can_use_tool',
        'hook_callback',
        'initialize',
        'remote_control',
        'set_model',
      ]);
    });

    it('carries direction across the chunk boundary from the importing union', () => {
      const found = bySymbol(
        extractControlMessages([schemasChunk, unionsChunk, dispatchChunk], '2.1.245')
      );

      // Direction is decided by the union chunk; membership resolves back to the
      // schema chunk. Both sides must survive the crossing.
      expect(found.get('can_use_tool')?.direction).toBe('cli_to_host');
      expect(found.get('hook_callback')?.direction).toBe('cli_to_host');
      expect(found.get('initialize')?.direction).toBe('host_to_cli');
      expect(found.get('set_model')?.direction).toBe('host_to_cli');
    });

    it("keeps the schema's own description, defined in a different chunk from its union", () => {
      const found = bySymbol(
        extractControlMessages([schemasChunk, unionsChunk, dispatchChunk], '2.1.245')
      );

      expect(found.get('initialize')?.description).toBe('Initializes the SDK session.');
    });

    it('still publishes a call-site-only subtype from the dispatch chunk', () => {
      const found = bySymbol(
        extractControlMessages([schemasChunk, unionsChunk, dispatchChunk], '2.1.245')
      );

      const remote = found.get('remote_control');
      expect(remote?.evidence).toBe('call_site');
      expect(remote?.direction).toBeNull();
    });

    it('does not depend on chunk order', () => {
      const forward = extractControlMessages([schemasChunk, unionsChunk, dispatchChunk], '2.1.245');
      const shuffled = extractControlMessages(
        [dispatchChunk, unionsChunk, schemasChunk],
        '2.1.245'
      );
      expect(shuffled).toEqual(forward);
    });

    it('treats a one-element array as the single-bundle case, byte for byte', () => {
      const asArray = extractControlMessages([bundle({})], '2.1.226');
      const asString = extractControlMessages(bundle({}), '2.1.226');
      expect(asArray).toEqual(asString);
    });

    it('resolves an import against the module it names, not an unrelated chunk reusing the export name', () => {
      // The correctness this rests on: a union imports its members from a SPECIFIC
      // module, and resolution is scoped to that module. Two unrelated chunks both
      // export `dup`, for DIFFERENT subtypes; the union imports `dup` from chunk-a, so
      // it must resolve to chunk-a's subtype, never chunk-b's. chunk-a is identified by
      // the names imported from it (`a0` and `dup`), which only chunk-a exports together.
      const chunkA = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var D=Ee(()=>Se({subtype:xt("cli_only")}).describe("A cli-only request."));',
        'export{A1 as a0,D as dup};',
      ].join('\n');
      const chunkB = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var D=Ee(()=>Se({subtype:xt("wrong_subtype")}).describe("The one that must NOT win."));',
        'export{A2 as b0,D as dup};',
      ].join('\n');
      const unions = [
        'import{a0 as p,dup as r}from"/$bunfs/root/chunk-a.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),r()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      const dispatch =
        'function h(e){if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="cli_only")return 2;return 0}';

      const found = bySymbol(extractControlMessages([chunkA, chunkB, unions, dispatch], '2.1.132'));

      expect([...found.keys()].sort()).toEqual(['cli_only', 'initialize']);
      expect(found.has('wrong_subtype')).toBe(false);
    });

    it('refuses when a control-request union loses a member to an unidentifiable source', () => {
      // If two chunks export the exact set of names imported from a source, the source
      // is unidentifiable — resolution must not guess. Dropping the member would be a
      // SILENT partial loss: the two resolved members still clear the floor guards
      // while the third subtype vanishes from the cache. The lane refuses instead.
      const chunkA = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var D=Ee(()=>Se({subtype:xt("ambiguous_one")}).describe("A."));',
        'export{A1 as e0,A2 as e1,D as amb};',
      ].join('\n');
      // A second chunk exports the SAME single name `amb`, so an import of just `amb`
      // matches both chunks and cannot be attributed to either.
      const chunkB = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var D=Ee(()=>Se({subtype:xt("ambiguous_two")}).describe("B."));',
        'export{D as amb};',
      ].join('\n');
      const unions = [
        'import{e0 as p,e1 as q}from"/$bunfs/root/chunk-a.js";',
        'import{amb as r}from"/$bunfs/root/chunk-ambiguous.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),q(),r()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      const dispatch =
        'function h(e){if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;return 0}';

      expect(() => extractControlMessages([chunkA, chunkB, unions, dispatch], '2.1.132')).toThrow(
        /could not uniquely identify/i
      );
    });

    it('refuses even when ambiguity leaves the control union with fewer than two resolved members', () => {
      // The bypass the raw-array check closes: dropping the ambiguous member leaves a
      // SINGLE resolved schema, which the `<2 members` filter would discard as a union
      // — silently, with no refusal. The routed member is still positive evidence this
      // was a control union, so the loss must refuse regardless of the count.
      const chunkA = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var D=Ee(()=>Se({subtype:xt("one")}).describe("A."));',
        'export{A1 as e0,D as amb};',
      ].join('\n');
      const chunkB = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var D=Ee(()=>Se({subtype:xt("two")}).describe("B."));',
        'export{D as amb};',
      ].join('\n');
      const unions = [
        'import{e0 as p}from"/$bunfs/root/chunk-a.js";',
        'import{amb as r}from"/$bunfs/root/chunk-ambiguous.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),r()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      const dispatch = 'function h(e){if(e.request.subtype==="initialize")return 1;return 0}';

      expect(() => extractControlMessages([chunkA, chunkB, unions, dispatch], '2.1.132')).toThrow(
        /could not uniquely identify/i
      );
    });

    it('refuses even when a lossy union looks non-control, since the lost member may be the routed one', () => {
      // The tail: a union whose RESOLVED members are all non-routed looks non-control —
      // but the member that did not resolve could be the routed one, which would make it
      // a control request. Its subtype is unknown, so refusing on any resolved schema +
      // an unresolvable member is the only safe call. Here `status`/`away_summary`
      // resolve (non-routed) while the routed `initialize` is the lost import.
      const schemas = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var N1=Ee(()=>Se({subtype:xt("status")}).describe("Status."));',
        'var N2=Ee(()=>Se({subtype:xt("away_summary")}).describe("Away."));',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'export{N1 as n1,N2 as n2,A1 as routed};',
      ].join('\n');
      // A second chunk also exports `routed`, so importing it alone is unidentifiable.
      const dup = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var D=Ee(()=>Se({subtype:xt("z")}));',
        'export{D as routed};',
      ].join('\n');
      const unions = [
        'import{n1 as p,n2 as q}from"/$bunfs/root/chunk-a.js";',
        'import{routed as r}from"/$bunfs/root/chunk-dup.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),q(),r()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      // `initialize` is routed on the request path — but it is the unresolved member.
      const dispatch = 'function h(e){if(e.request.subtype==="initialize")return 1;return 0}';

      expect(() => extractControlMessages([schemas, dup, unions, dispatch], '2.1.132')).toThrow(
        /could not uniquely identify/i
      );
    });

    it('does not refuse an array of unresolved members with no resolved schema', () => {
      // An array whose members none resolve to a schema is not a union of subtypes — it
      // is the ordinary shape every build carries (arrays of imported components,
      // handlers, and the like). It has no signal to act on, so it must NOT refuse.
      const schemas = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'export{A1 as e0,A2 as e1};',
      ].join('\n');
      const unions = [
        'import{e0 as p,e1 as q}from"/$bunfs/root/chunk-schemas.js";',
        // Nothing exports g0/g1, so this source is unidentifiable and both are unresolved.
        'import{g0 as x,g1 as y}from"/$bunfs/root/chunk-ghost.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var C=Ee(()=>fs([p(),q()]).describe("Control requests a client sends to drive the loop."));',
        'var X=Ee(()=>fs([x(),y()]));',
      ].join('\n');
      const dispatch =
        'function h(e){if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;return 0}';

      const found = bySymbol(extractControlMessages([schemas, unions, dispatch], '2.1.132'));

      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
    });

    it('does not fingerprint a chunk by a name it only RE-exports from another module', () => {
      // `export{X as reY}from"m"` re-exports another module's schema. This chunk is not
      // reY's real source, so it must not be identified as such — otherwise reY resolves
      // to nothing (no local schema backs it) and its subtype is dropped silently.
      // Skipping the re-export leaves reY unidentifiable, so the union is refused.
      const schemas = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Init."));',
        'export{A1 as e0};',
      ].join('\n');
      const facade = 'export{ghost as reY}from"/$bunfs/root/somewhere.js";';
      const unions = [
        'import{e0 as p}from"/$bunfs/root/chunk-schemas.js";',
        'import{reY as r}from"/$bunfs/root/facade.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),r()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      const dispatch = 'function h(e){if(e.request.subtype==="initialize")return 1;return 0}';

      expect(() => extractControlMessages([schemas, facade, unions, dispatch], '2.1.132')).toThrow(
        /could not uniquely identify/i
      );
    });

    it('reads string-literal import and export specifier names', () => {
      // ES2022 arbitrary module names: `export{A as "e0"}` / `import{"e0" as p}`. The
      // real bundle uses identifiers, but the specifier reader must not choke on the
      // string form, which is one minifier setting away.
      const schemas = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'export{A1 as "e0",A2 as "e1"};',
      ].join('\n');
      const unions = [
        'import{"e0" as p,"e1" as q}from"/$bunfs/root/chunk-schemas.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),q()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      const dispatch =
        'function h(e){if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;return 0}';

      const found = bySymbol(extractControlMessages([schemas, unions, dispatch], '2.1.132'));

      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
    });

    it('ignores default and namespace import specifiers', () => {
      // Only named imports (`import{E as L}`) carry a cross-chunk export name. A default
      // or namespace specifier binds something else and must be skipped, not read as an
      // alias.
      const schemas = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'export{A1 as e0,A2 as e1};',
      ].join('\n');
      const unions = [
        'import D from"/$bunfs/root/chunk-x.js";',
        'import * as NS from"/$bunfs/root/chunk-y.js";',
        'import{e0 as p,e1 as q}from"/$bunfs/root/chunk-schemas.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),q()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      const dispatch =
        'function h(e){if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;return 0}';

      const found = bySymbol(extractControlMessages([schemas, unions, dispatch], '2.1.132'));

      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model']);
    });

    it('resolves a schema even when an unrelated chunk exports the same name as a non-schema', () => {
      // Module identity makes this safe where a global name map could not: the schemas
      // chunk is identified by the full set imported from it (`e0,e1,e2`), which the
      // collider — exporting only `e2`, for something that is not a schema — does not
      // match. So `e2` resolves to the schemas chunk's real subtype rather than being
      // dropped or confused.
      const schemas = [
        'var Ee=(f)=>f,Se=(o)=>o,xt=(s)=>s,jj=1;',
        'var A1=Ee(()=>Se({subtype:xt("initialize")}).describe("Initializes."));',
        'var A2=Ee(()=>Se({subtype:xt("set_model")}).describe("Sets the model."));',
        'var P=Ee(()=>Se({subtype:xt("third_subtype")}).describe("The third."));',
        // `h0` is a NON-schema export of the same (identified) chunk — imported into the
        // union below, it resolves to nothing and is dropped, never a subtype.
        'export{A1 as e0,A2 as e1,P as e2,jj as h0};',
      ].join('\n');
      // A different chunk exports the SAME name `e2`, but for a non-schema binding.
      const collider = ['var junk=1;', 'export{junk as e2};'].join('\n');
      const unions = [
        'import{e0 as p,e1 as q,e2 as r,h0 as h}from"/$bunfs/root/chunk-schemas.js";',
        'var Ee=(f)=>f,fs=(a)=>a;',
        'var U=Ee(()=>fs([p(),q(),r(),h()]).describe("Control requests a client sends to drive the loop."));',
      ].join('\n');
      const dispatch =
        'function h(e){if(e.request.subtype==="initialize")return 1;' +
        'else if(e.request.subtype==="set_model")return 2;return 0}';

      // Below the split floor so the two-direction guard does not fire — the point here
      // is cross-module resolution, not directions.
      const found = bySymbol(
        extractControlMessages([schemas, collider, unions, dispatch], '2.1.132')
      );

      expect([...found.keys()].sort()).toEqual(['initialize', 'set_model', 'third_subtype']);
    });
  });
});
