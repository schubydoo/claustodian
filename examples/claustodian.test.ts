// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ClaudeSymbol, ControlFamily, SymbolType } from './claustodian.js';

/**
 * The published client restates the record contract by hand, and nothing checked
 * that restatement until now. `examples/` sat outside tsconfig's `include`, so
 * `tsc --noEmit` never read the file at all; widening the schema's `type` enum for
 * `control_message` left `SymbolType` a strict subset of it, and every gate passed.
 *
 * Putting `examples/` in the type-check gate is necessary but NOT sufficient — the
 * compiler cannot know what the schema says. These assertions close the loop from
 * both ends: the runtime half reads the schema's own enum and compares it to the
 * list below, and the type half proves that list is exactly `SymbolType`. Adding a
 * member to the schema alone fails the first; adding it to the client alone fails
 * the second. That pair is what the earlier omission would have tripped.
 */
const SYMBOL_TYPES = [
  'cli_flag',
  'command',
  'env_var',
  'config_key',
  'internal_config_flag',
  'control_message',
] as const;

/**
 * The schema's `family` enum has one member today, and its own description says it
 * widens if further message families are published. That makes it the next enum
 * likely to drift, so it is pinned the same way rather than left to the `type` pair.
 */
const CONTROL_FAMILIES = ['control_request'] as const;

/**
 * True only when A and B are the same type — not merely mutually assignable, which
 * a plain `extends` pair reports for a union and its own superset.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const schema = JSON.parse(
  readFileSync(new URL('../schema/symbol.schema.json', import.meta.url), 'utf8')
) as { properties: { type: { enum: string[] }; family: { enum: string[] } } };

/** Every field the contract requires on every record, so each case varies one thing. */
const base = {
  symbol: '--output-format',
  first_seen: '0.2.66',
  removed_in: null,
  status: 'active',
  provenance: 'binary',
  confidence: 'high',
  description: 'Sets the output format.',
  source_url: null,
  category: 'cli',
} as const;

const accept = (record: ClaudeSymbol): ClaudeSymbol => record;

describe('the published client mirrors the record contract', () => {
  it('types exactly the type enum the schema declares, in both directions', () => {
    // Runtime: the schema's enum against the list. Sorted, because the schema's
    // order is not part of the contract and should not be able to fail this.
    expect([...schema.properties.type.enum].sort()).toEqual([...SYMBOL_TYPES].sort());

    // Compile time: the list against `SymbolType`. If the client's union gains or
    // loses a member relative to the list, `Equal` is false and this stops
    // compiling — which the type-check gate now runs over `examples/`.
    const typesMatch: Equal<SymbolType, (typeof SYMBOL_TYPES)[number]> = true;
    expect(typesMatch).toBe(true);
  });

  it('types exactly the family enum the schema declares, in both directions', () => {
    expect([...schema.properties.family.enum].sort()).toEqual([...CONTROL_FAMILIES].sort());

    const familiesMatch: Equal<ControlFamily, (typeof CONTROL_FAMILIES)[number]> = true;
    expect(familiesMatch).toBe(true);
  });

  it('requires family and direction on control_message records', () => {
    const control = {
      ...base,
      type: 'control_message',
      family: 'control_request',
      direction: 'host_to_cli',
    } as const;
    expect(accept(control).type).toBe('control_message');

    // `direction` is nullable — not observable is a legitimate value, and the
    // schema's `oneOf` admits it.
    const nullDirection = { ...control, direction: null } as const;
    expect(accept(nullDirection).direction).toBeNull();

    const missingBoth = { ...base, type: 'control_message' } as const;
    // @ts-expect-error — the schema `required`s both fields on this type
    accept(missingBoth);

    const missingDirection = {
      ...base,
      type: 'control_message',
      family: 'control_request',
    } as const;
    // @ts-expect-error — `direction` is required too, not just `family`
    accept(missingDirection);
  });

  it('forbids family and direction on every other type', () => {
    const flagWithFamily = { ...base, type: 'cli_flag', family: 'control_request' } as const;
    // @ts-expect-error — the schema's `else` branch sets `family: false` here
    accept(flagWithFamily);

    const flagWithDirection = { ...base, type: 'cli_flag', direction: 'host_to_cli' } as const;
    // @ts-expect-error — and `direction: false` alongside it
    accept(flagWithDirection);

    // The same record without them is the shape the dataset actually ships.
    const plainFlag = { ...base, type: 'cli_flag' } as const;
    expect(accept(plainFlag).type).toBe('cli_flag');
  });

  it('narrows to the control fields on the type tag alone', () => {
    const sym: ClaudeSymbol = {
      ...base,
      symbol: 'initialize',
      type: 'control_message',
      family: 'control_request',
      direction: 'host_to_cli',
      category: 'control-protocol',
    };

    // The control variant must carry `direction`, and narrowing on the tag alone
    // must reach it — no cast, no `?.`. The literal above is freshness-checked
    // against `ClaudeSymbol`, so dropping `direction` from that variant fails here.
    // (What a flat optional-field shape would break is the pair of forbidden-field
    // cases above, whose `@ts-expect-error` directives would go unused.)
    expect(sym.type === 'control_message' ? sym.direction : 'unreachable').toBe('host_to_cli');
  });
});
