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

  it('takes bytes because decoding first would merge the regions', () => {
    // Not about NUL — that survives a UTF-8 round trip. The hazard is that INVALID
    // sequences decode to U+FFFD, whose code point is >= 0x80 and therefore counts
    // as printable by the run rule. Scan a decoded string and the separators between
    // embedded regions vanish, so everything reads as one continuous run and nothing
    // gets sliced. Hence the API takes bytes.
    const invalid = Buffer.from([0xff, 0xfe, 0xff]);
    const decoded = invalid.toString('utf-8');
    expect(decoded).toBe('\uFFFD\uFFFD\uFFFD');
    expect(decoded.charCodeAt(0)).toBeGreaterThanOrEqual(0x80);
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

  it('falls back to the largest region when no banner is present', () => {
    const small = jsRegion(false, 2, 'small');
    const large = jsRegion(false, 4, 'large');
    expect(sliceEmbeddedBundle(artifact(small, large))).toContain('/*large*/');
  });

  it('refuses rather than returning a region too small to be a CLI bundle', () => {
    // Returning something dubious is the dangerous outcome: a wrong region does not
    // fail, it reports wrong counts. The oldest compiled release is 12.4 MiB.
    expect(() => sliceEmbeddedBundle(artifact('// @bun tiny'), '2.1.113')).toThrow(
      /below the .* floor for a CLI bundle/
    );
  });

  it('names the artifact in its refusal, so a sweep says which version failed', () => {
    expect(() => sliceEmbeddedBundle(artifact('tiny'), '2.1.199')).toThrow(/2\.1\.199/);
  });

  it('never returns the raw artifact as a fallback', () => {
    // A fallback would push the failure into the parser, which would then blame the
    // bundle for being unparseable rather than the slicer for finding nothing.
    let threw = false;
    try {
      sliceEmbeddedBundle(artifact('nope'), 'x');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
