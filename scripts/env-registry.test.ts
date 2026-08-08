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

  it('resolves to the CLOSEST typed binding when the target name is reused', () => {
    // Minified assignment targets repeat across modules. At 2.1.224, 17
    // builder-bound names are also assigned elsewhere (`tag` 106 times), so a
    // global name->type map would validate any getter referencing a local `tag`
    // on the strength of an unrelated `tag=$e.str()` in another module.
    // The filler is `;`-separated: a run of bare word characters would merge
    // with the following `tag=` into one identifier and resolve nothing.
    // The distant binding is deliberately LAST in source order, so "closest" and
    // "last one wins" give different answers and the test can tell them apart.
    const src =
      `${BUILDER}Y={NEAR_VAR:()=>tag};tag=$e.int();` + 'x;'.repeat(2000) + 'tag=$e.str();';
    expect(extractRegistryEnvVars(src).get('NEAR_VAR')).toBe('int');
  });

  it('rejects a getter whose name is reassigned between it and the binding', () => {
    // An intervening assignment means the getter closes over a DIFFERENT `tag`.
    const src =
      `${BUILDER}Y={OTHER_MODULE:()=>tag};tag=somethingElse();` +
      'z;'.repeat(100) +
      'tag=$e.bool();';
    expect(extractRegistryEnvVars(src).has('OTHER_MODULE')).toBe(false);
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

  it('is not fooled by a brace inside a string in the builder body', () => {
    const src = '$e={str:()=>a("{"),bool:()=>b(),int:()=>c()};x=$e.str();X={QUOTED:()=>x}';
    expect(extractRegistryEnvVars(src).get('QUOTED')).toBe('str');
  });

  it('handles an escaped quote inside the builder body', () => {
    const src = '$e={str:()=>a("\\"{"),bool:()=>b(),int:()=>c()};x=$e.int();X={ESCAPED:()=>x}';
    expect(extractRegistryEnvVars(src).get('ESCAPED')).toBe('int');
  });

  it('gives up on an unterminated object instead of scanning to the end', () => {
    // No closing brace: the body read stops at its cap and the object simply
    // fails the core-method check rather than hanging or matching wildly.
    expect(extractRegistryEnvVars('$e={str:()=>a(),bool:()=>b(),int:()=>c(').size).toBe(0);
  });

  it('finds a builder whose str constructor is not the first key', () => {
    // The search anchors on `str:(` and walks back to the object's own `NAME={`,
    // so the anchor is usually mid-object rather than adjacent to the brace.
    const src = '$e={bool:()=>b(),int:()=>c(),str:()=>a()};x=$e.bool();X={LATER_KEY:()=>x}';
    expect(extractRegistryEnvVars(src).get('LATER_KEY')).toBe('bool');
  });

  it('does not count a longer identifier or an equality test as a reassignment', () => {
    // `myTag=` and `tag==` both contain `tag=` but neither rebinds it.
    const src =
      `${BUILDER}Y={STILL_GOOD:()=>tag};myTag=1;if(tag==2){}` + 'z;'.repeat(50) + 'tag=$e.bool();';
    expect(extractRegistryEnvVars(src).get('STILL_GOOD')).toBe('bool');
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
