// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
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

    it('returns empty below the union floor, where absence is expected', () => {
      expect(extractControlMessages('var x=1;', '2.1.20')).toEqual([]);
    });

    it('throws on source it cannot parse, rather than reporting zero symbols', () => {
      expect(() => extractControlMessages('function (){', '2.1.226')).toThrow(/parse/i);
    });
  });

  describe('floors', () => {
    it('pins the two floors this lane depends on', () => {
      // Both are measured, not chosen: 2.1.30 is the first union array, 2.1.133
      // the first direction split. Changing either changes what null means.
      expect(CONTROL_UNION_FLOOR).toBe('2.1.30');
      expect(CONTROL_SPLIT_FLOOR).toBe('2.1.133');
    });
  });
});
