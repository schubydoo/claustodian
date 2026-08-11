// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { BUN_BANNER, looksLikeSource, sliceEmbeddedBundle } from './slice-bundle.js';

/** Bytes that are not printable text, standing in for a compiled wrapper. */
const wrapper = (n: number): Buffer => Buffer.alloc(n, 0);

/** A run of plausible JS large enough to clear the size floor. */
function jsRegion(banner: boolean, mib: number, marker = 'x'): string {
  const head = banner ? `${BUN_BANNER} @bytecode @bun-cjs\n` : '';
  const body = `/*${marker}*/`.padEnd(Math.round(mib * 1024 * 1024), ' ');
  return head + body;
}

/** A compiled-artifact stand-in: wrapper bytes around one or more text regions. */
function artifact(...regions: string[]): Buffer {
  const parts: Buffer[] = [wrapper(4096)];
  for (const region of regions) {
    parts.push(Buffer.from(region, 'utf-8'), wrapper(512));
  }
  return Buffer.concat(parts);
}

describe('looksLikeSource', () => {
  it('accepts plain JavaScript, which the npm era hands over already extracted', () => {
    expect(looksLikeSource(Buffer.from('const a = 1;\n', 'utf-8'))).toBe(true);
  });

  it('rejects a compiled artifact by its NUL bytes', () => {
    expect(looksLikeSource(artifact(jsRegion(true, 2)))).toBe(false);
  });

  it('is a negative test, so an artifact without an early NUL reads as source', () => {
    // Worth pinning because it is the module's one remaining path back to the raw
    // input. The misclassification is loud — the caller's parser rejects it — but it
    // is loud one step later and blames the bundle rather than this judgement.
    const noEarlyNul = Buffer.concat([Buffer.from('x'.repeat(9000), 'utf-8'), Buffer.alloc(16, 0)]);
    expect(looksLikeSource(noEarlyNul)).toBe(true);
  });
});

describe('sliceEmbeddedBundle', () => {
  it('returns npm-era source unchanged', () => {
    const source = 'const a = 1;\n';
    expect(sliceEmbeddedBundle(Buffer.from(source, 'utf-8'))).toBe(source);
  });

  it('extracts the embedded region from a compiled artifact', () => {
    const region = jsRegion(true, 2, 'cli');
    const out = sliceEmbeddedBundle(artifact(region));
    expect(out.startsWith(BUN_BANNER)).toBe(true);
    expect(out).toContain('/*cli*/');
    expect(out).toBe(region);
  });

  it('prefers the banner-carrying region over a LARGER one', () => {
    // The real failure this guards: releases vendor mermaid, highlight.js and
    // Chart.js alongside the CLI. Picking by size alone works today only because
    // the CLI happens to be biggest, and would silently follow a future release
    // that vendors something bigger.
    const cli = jsRegion(true, 2, 'cli');
    const vendored = jsRegion(false, 6, 'vendored');
    const out = sliceEmbeddedBundle(artifact(vendored, cli));

    expect(out).toContain('/*cli*/');
    expect(out).not.toContain('/*vendored*/');
  });

  it('refuses when no region carries the banner, rather than taking the largest', () => {
    // The failure the banner exists to prevent. Releases vendor mermaid,
    // highlight.js and Chart.js; "largest" works today only because the CLI happens
    // to be biggest, and a release that vendored something bigger would be extracted
    // from the wrong region without failing.
    const vendored = jsRegion(false, 4, 'vendored');
    expect(() => sliceEmbeddedBundle(artifact(vendored), '2.1.999')).toThrow(
      /no region .* begins with/
    );
  });

  it('accepts several banner regions while they are identical', () => {
    // 2.1.113 embeds the CLI bundle twice, as two identical 12.39 MiB regions.
    const copy = jsRegion(true, 2, 'cli');
    const out = sliceEmbeddedBundle(artifact(copy, copy), '2.1.113');
    expect(out).toBe(copy);
  });

  it('refuses when several banner regions disagree at the SAME size', () => {
    // Same length, different content — so this fails for a content digest and passes
    // for a length comparison. An earlier version of this test used regions of
    // different sizes, which pinned nothing: it survived replacing the digest with
    // a length check, which is the cheap wrong implementation someone would reach
    // for. File order is not evidence for which copy the CLI runs.
    const a = jsRegion(true, 2, 'aaa');
    const b = jsRegion(true, 2, 'bbb');
    expect(a.length).toBe(b.length);
    expect(a).not.toBe(b);
    expect(() => sliceEmbeddedBundle(artifact(a, b), '2.1.500')).toThrow(/not identical/);
  });

  it('refuses a banner region too small to be a CLI bundle', () => {
    // Returning something dubious is the dangerous outcome: a wrong region does not
    // fail, it reports wrong counts. The smallest compiled bundle measured is
    // 12.39 MiB, so a banner on a few bytes is a marker, not the CLI.
    expect(() => sliceEmbeddedBundle(artifact('// @bun tiny'), '2.1.113')).toThrow(
      /clears the \d+-byte floor/
    );
  });

  it('names the artifact in its refusal, so a sweep says which version failed', () => {
    expect(() => sliceEmbeddedBundle(artifact('tiny'), '2.1.199')).toThrow(/2\.1\.199/);
  });

  it('refuses an artifact with no printable region at all', () => {
    expect(() => sliceEmbeddedBundle(Buffer.alloc(9000, 0), 'empty')).toThrow(
      /no region .* begins with/
    );
  });
});
