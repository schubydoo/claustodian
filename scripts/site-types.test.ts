// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard: every symbol type the dataset publishes must be a first-class citizen of
 * the static site. `control_message` shipped in the data but was unselectable in
 * the Type filter, unexplained in the legend, and unlabelled in the grouped view,
 * because `site/index.html` restated the type list in hardcoded places. The site
 * now derives its Type dropdown and group labels from the data (TYPE_LABELS with a
 * raw-value fallback), but two things still cannot derive themselves — a friendly
 * label and a legend entry — so this test fails CI the moment a new type lacks
 * either. See scratch/tasks.md "Derive UI lists from the data".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../site/index.html', import.meta.url)), 'utf-8');
const latest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/latest.json', import.meta.url)), 'utf-8')
) as { symbols: Array<{ type: string }> };

const liveTypes = [...new Set(latest.symbols.map((s) => s.type))].sort();

/** Keys of the `const TYPE_LABELS = new Map([...])` literal in the page. */
function typeLabelKeys(): string[] {
  const block = html.match(/const TYPE_LABELS = new Map\(\[([\s\S]*?)\]\);/);
  if (!block) throw new Error('TYPE_LABELS map not found in site/index.html');
  return [...block[1]!.matchAll(/\[\s*'([a-z_]+)'\s*,/g)].map((m) => m[1] as string);
}

/** Types that carry a legend chip: `<span class="badge t-<type>">`. */
function legendBadgeTypes(): Set<string> {
  return new Set([...html.matchAll(/class="badge t-([a-z_]+)"/g)].map((m) => m[1] as string));
}

/** Types with a `.t-<type>` colour rule in the stylesheet. */
function styledTypes(): Set<string> {
  return new Set([...html.matchAll(/\.t-([a-z_]+)\s*[,{]/g)].map((m) => m[1] as string));
}

describe('site type coverage', () => {
  it('the data actually has types to check (instrument can fail)', () => {
    expect(liveTypes.length).toBeGreaterThan(1);
    expect(typeLabelKeys().length).toBeGreaterThan(1);
    expect(legendBadgeTypes().size).toBeGreaterThan(1);
  });

  it('every published type has a TYPE_LABELS entry', () => {
    const labelled = new Set(typeLabelKeys());
    const missing = liveTypes.filter((t) => !labelled.has(t));
    expect(missing, `types missing a friendly label in TYPE_LABELS: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  it('every published type has a legend entry', () => {
    const badges = legendBadgeTypes();
    const missing = liveTypes.filter((t) => !badges.has(t));
    expect(missing, `types missing a legend chip: ${missing.join(', ')}`).toEqual([]);
  });

  it('every published type has a badge colour rule', () => {
    const styled = styledTypes();
    const missing = liveTypes.filter((t) => !styled.has(t));
    expect(missing, `types missing a .t-<type> colour rule: ${missing.join(', ')}`).toEqual([]);
  });
});
