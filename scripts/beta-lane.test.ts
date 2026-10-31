// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BETA_FLOOR, extractBetas } from './beta-lane.js';

const FACTORY = 'function k(e,s){return Object.freeze({name:e,header:s})}';

/** `n` registry calls through the factory `k`, plus `extra`. */
const registry = (n: number, extra = '') =>
  `${FACTORY}var R=[${Array.from({ length: n }, (_, i) => `k("beta_${i}","beta-${i}-2026-01-01")`).join(',')}${extra}];`;

describe('extractBetas', () => {
  it('reads each factory call as a header, named by its registry name', () => {
    const betas = extractBetas(registry(12), BETA_FLOOR);
    expect(betas).toHaveLength(12);
    expect(betas[0]).toEqual({ header: 'beta-0-2026-01-01', names: ['beta_0'] });
  });

  it('keeps one header under every name that registers it, and two headers under one name', () => {
    const extra =
      ',k("tool_search","tool-search-tool-2025-10-19"),k("tool_search","advanced-tool-use-2025-11-20"),k("alias","beta-0-2026-01-01")';
    const betas = extractBetas(registry(12, extra), BETA_FLOOR);
    expect(betas.filter((b) => b.names.includes('tool_search')).map((b) => b.header)).toEqual([
      'advanced-tool-use-2025-11-20',
      'tool-search-tool-2025-10-19',
    ]);
    expect(betas.find((b) => b.header === 'beta-0-2026-01-01')?.names).toEqual(['alias', 'beta_0']);
  });

  it('counts only calls that resolve to the factory, not a same-named function elsewhere', () => {
    // Inside f, k is a parameter: its call is some other function, not the registry.
    const other = 'function f(k){return k("tengu_event","not-a-beta-2026-01-01")}';
    const headers = extractBetas(registry(12) + other, BETA_FLOOR).map((b) => b.header);
    expect(headers).not.toContain('not-a-beta-2026-01-01');
  });

  it('follows a header written as a variable', () => {
    const src = registry(12, ',k("oauth_auth",H)') + 'var H="oauth-2025-04-20";';
    expect(extractBetas(src, BETA_FLOOR).map((b) => b.header)).toContain('oauth-2025-04-20');
  });

  it('reads a call in another chunk that imports the factory', () => {
    const owner = `${registry(12)}export{k as F};`;
    const user =
      'import{F as q}from"/$bunfs/root/chunk-a.js";var X=q("speed","fast-mode-2026-02-01");';
    expect(extractBetas([owner, user], BETA_FLOOR).map((b) => b.header)).toContain(
      'fast-mode-2026-02-01'
    );
  });

  it('refuses a factory call whose header it cannot read', () => {
    expect(() => extractBetas(registry(12, ',k("x",g())'), BETA_FLOOR)).toThrow(/CallExpression/);
  });

  it('refuses a registry too short to be the whole list', () => {
    expect(() => extractBetas(registry(11), BETA_FLOOR)).toThrow(/11 beta headers/);
  });

  it('refuses two factories', () => {
    const second = 'function m(a,b){return Object.freeze({name:a,header:b})}';
    expect(() => extractBetas(registry(12) + second, BETA_FLOOR)).toThrow(/2 beta factories/);
  });

  it('asserts nothing before the floor', () => {
    expect(extractBetas(registry(12), '2.1.123')).toEqual([]);
  });
});
