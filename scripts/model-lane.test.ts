// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { MODEL_FLOOR, REGISTRY_FLOOR, extractModels } from './model-lane.js';

/** A provider object as the pre-registry bundle writes it. */
const provider = (id: string) => `var P={firstParty:"${id}",bedrock:"us.anthropic.${id}-v1:0"};`;

/** A registry of `n` entries, the second shape. */
const registry = (n: number, extra = '') =>
  `var R=[${Array.from(
    { length: n },
    (_, i) =>
      `{id:"claude-test-${i}",family:"test",display_name:"Test ${i}",provider_ids:{first_party:"claude-test-${i}-20260101"}}`
  ).join(',')}${extra}];`;

describe('extractModels', () => {
  it('reads a provider object by its first-party id', () => {
    expect(extractModels(provider('claude-3-7-sonnet-20250219'), '0.2.9')).toEqual([
      { id: 'claude-3-7-sonnet-20250219' },
    ]);
  });

  it('follows a variable to its declaration, as 0.2.62 writes the id', () => {
    const src = 'var O="claude-3-7-sonnet-20250219",S={firstParty:O,bedrock:"b"};';
    expect(extractModels(src, '0.2.62')).toEqual([{ id: 'claude-3-7-sonnet-20250219' }]);
  });

  it('resolves by scope, not by spelling', () => {
    // The inner O is a parameter, so the object's id cannot be read and must stop the run.
    const src =
      'var O="claude-3-7-sonnet-20250219";function f(O){return{firstParty:O,bedrock:"b"}}';
    expect(() => extractModels(src, '0.2.62')).toThrow(/cannot read/);
  });

  it('skips retirement dates and null entries, which have the same keys', () => {
    const src =
      provider('claude-opus-4-20250514') +
      'var D={retirementDates:{firstParty:"June 15, 2026",bedrock:"May 31, 2026"}};' +
      'var N={firstParty:null,bedrock:null};';
    expect(extractModels(src, '2.1.170')).toEqual([{ id: 'claude-opus-4-20250514' }]);
  });

  it('reads the registry with display names, keyed by the first-party id', () => {
    const models = extractModels(registry(10), REGISTRY_FLOOR);
    expect(models).toHaveLength(10);
    expect(models[0]).toEqual({ id: 'claude-test-0-20260101', name: 'Test 0' });
  });

  it('joins both shapes at the registry floor, and reads only the registry after it', () => {
    const src = registry(10) + provider('claude-mythos-5');
    expect(extractModels(src, REGISTRY_FLOOR).map((m) => m.id)).toContain('claude-mythos-5');
    // After the floor the provider keys belong to adapters and limits, which are not models.
    const later = registry(10) + 'var A={firstParty:t.first_party,bedrock:t.bedrock};';
    expect(extractModels(later, '2.1.196')).toHaveLength(10);
    expect(() => extractModels(later, REGISTRY_FLOOR)).toThrow(/MemberExpression/);
  });

  it('refuses a registry too short to be the whole list', () => {
    expect(() => extractModels(registry(9), REGISTRY_FLOOR)).toThrow(/9 model registry entries/);
  });

  it('refuses one model with two display names', () => {
    const twice = `,{display_name:"Other",provider_ids:{first_party:"claude-test-0-20260101"}}`;
    expect(() => extractModels(registry(10, twice), REGISTRY_FLOOR)).toThrow(/two display names/);
  });

  it('refuses a release from the floor that names no model', () => {
    expect(() => extractModels('var a=1;', MODEL_FLOOR)).toThrow(/names no model/);
  });
});
