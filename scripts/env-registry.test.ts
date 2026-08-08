// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { extractRegistryEnvVars } from './env-registry.js';

/** The real 2.1.224 builder shape, including the comma-bearing `enum` value. */
const BUILDER =
  '$e={str:()=>aJh(),bool:()=>lJh(),triBool:()=>cJh(),int:(e)=>e?rsc(e):uJh(),' +
  'enum:(e)=>Me.preprocess(_Yr,Me.string().optional())};';

describe('extractRegistryEnvVars', () => {
  it('resolves a getter entry through its typed binding', () => {
    const src = `${BUILDER}olg=$e.bool(),nxt=$e.str();X={EMBEDDED_SEARCH_TOOLS:()=>olg,SOME_PATH:()=>nxt}`;
    const env = extractRegistryEnvVars(src);
    expect(env.get('EMBEDDED_SEARCH_TOOLS')).toBe('bool');
    expect(env.get('SOME_PATH')).toBe('str');
  });

  it('detects the builder despite the comma-bearing enum constructor', () => {
    // The object body cannot be matched entry-by-entry: `enum:(e)=>Me.preprocess(
    // _Yr,Me.string()…)` carries commas and parens of its own.
    expect(extractRegistryEnvVars(`${BUILDER}a=$e.enum(),X={MODE:()=>a}`).get('MODE')).toBe('enum');
  });

  it('resolves against the NEAREST preceding definition when a name is reused', () => {
    // 2.1.224 binds `$e` three times — the registry builder, an array, and a
    // bundled graph library whose methods are neighborhood/incomers/maxDegree.
    // Resolving against the wrong one would admit graph API calls as env vars.
    const src =
      `${BUILDER}good=$e.bool();` +
      '$e={neighborhood:()=>1,incomers:()=>2,maxDegree:()=>3};bad=$e.neighborhood();' +
      'X={REAL_VAR:()=>good,NOT_A_VAR:()=>bad}';
    const env = extractRegistryEnvVars(src);
    expect(env.get('REAL_VAR')).toBe('bool');
    expect(env.has('NOT_A_VAR')).toBe(false);
  });

  it('rejects a binding made before the builder exists', () => {
    const src = `early=$e.bool();${BUILDER}X={TOO_EARLY:()=>early}`;
    expect(extractRegistryEnvVars(src).has('TOO_EARLY')).toBe(false);
  });

  it('rejects a method the builder does not declare', () => {
    const src = `${BUILDER}a=$e.notAType();X={NOPE:()=>a}`;
    expect(extractRegistryEnvVars(src).has('NOPE')).toBe(false);
  });

  it('accepts a builder that adds an unknown constructor', () => {
    // `enum` did not exist at 2.1.160. Pinning an exact method set would zero the
    // lane the next time Anthropic adds a type.
    const src =
      '$e={str:()=>a(),bool:()=>b(),int:()=>c(),url:()=>d()};u=$e.url();X={SOME_URL:()=>u}';
    expect(extractRegistryEnvVars(src).get('SOME_URL')).toBe('url');
  });

  it('ignores an object missing a core constructor', () => {
    const src = '$e={str:()=>a(),bool:()=>b()};x=$e.str();X={NOT_REGISTRY:()=>x}';
    expect(extractRegistryEnvVars(src).size).toBe(0);
  });

  it('returns empty below the registry floor rather than failing', () => {
    // 2.1.159 has no builder. Absence here is a normal property of the older
    // eras, so it must never read as an error or as a removal.
    expect(extractRegistryEnvVars('process.env.CLAUDE_CODE_X;let a=1;').size).toBe(0);
  });

  it('does not treat a lowercase or short key as a registry entry', () => {
    const src = `${BUILDER}a=$e.str();X={lower:()=>a,AB:()=>a}`;
    expect(extractRegistryEnvVars(src).size).toBe(0);
  });
});
