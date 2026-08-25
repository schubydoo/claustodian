// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  BUN_BANNER,
  BUNFS_MODULE_ROOT,
  looksLikeSource,
  sliceEmbeddedBundle,
  sliceEmbeddedChunks,
} from './slice-bundle.js';

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

/** A code-split chunk (2.1.242+): the bytecode banner, then whatever body follows. */
function chunkRegion(body: string): string {
  return `${BUN_BANNER} @bytecode\n${body}`;
}

describe('sliceEmbeddedChunks', () => {
  it('returns npm-era source as a single element', () => {
    const source = 'const a = 1;\n';
    expect(sliceEmbeddedChunks(Buffer.from(source, 'utf-8'))).toEqual([source]);
  });

  it('returns the single-bundle era as one element, matching sliceEmbeddedBundle', () => {
    const region = jsRegion(true, 2, 'cli');
    const art = artifact(region);
    expect(sliceEmbeddedChunks(art)).toEqual([sliceEmbeddedBundle(art)]);
  });

  it('delegates single-bundle refusals — differing regions with no chunk imports still throw', () => {
    // No `from"/$bunfs/root/` import anywhere, so this is NOT the split era: two
    // differing banner regions are the old ambiguity, and the refusal must fire.
    const a = jsRegion(true, 2, 'aaa');
    const b = jsRegion(true, 2, 'bbb');
    expect(() => sliceEmbeddedChunks(artifact(a, b), '2.1.500')).toThrow(/not identical/);
  });

  it('returns every chunk in the code-split era, ignoring the size floor', () => {
    // The split era is normal, not a refusal. One chunk imports another through the
    // bunfs path — the era signal — and a legitimate chunk can be a few bytes, far
    // below the single-bundle floor, because the protocol schemas live in small
    // chunks. Both must come back.
    const big = chunkRegion(`import{x as y}from"${BUNFS_MODULE_ROOT}aaaa.js";var z=1;`);
    const tiny = chunkRegion('export{q as x};var q=2;');
    // `xx` is a short printable run that does not open with the bytecode banner — it is
    // scanned and rejected, and must not appear in the result.
    const out = sliceEmbeddedChunks(artifact(big, 'xx', tiny), '2.1.245');
    expect(out).toEqual([big, tiny]);
  });

  it('keeps a below-floor chunk that the single-bundle floor would have dropped', () => {
    const importer = chunkRegion(`import{s as t}from"${BUNFS_MODULE_ROOT}bbbb.js";var u=1;`);
    const small = chunkRegion('export{v as s};var v=0;'); // a few dozen bytes
    const out = sliceEmbeddedChunks(artifact(importer, small), '2.1.245');
    expect(out).toContain(small);
  });

  it('refuses a split-era artifact whose bunfs import carries no bytecode chunk region', () => {
    // The era signal is present (a `from"/$bunfs/root/` import) but nothing opens with
    // the bytecode banner — a shape this does not understand. It must refuse rather than
    // return an empty chunk list that reads downstream as a vanished protocol.
    const strayImport = `import{x as y}from"${BUNFS_MODULE_ROOT}zzzz.js";var z=1;`;
    expect(() => sliceEmbeddedChunks(artifact(strayImport), '2.1.777')).toThrow(
      /carries no .* chunk region/
    );
  });

  it('detects the split era by import syntax, not the chunk filename shape', () => {
    // The filenames are NOT stable: 2.1.242..245 used `chunk-<hash>.js`, 2.1.246 renamed
    // them to `_<n>.js`. Detection keys on the `from"/$bunfs/root/` import, so a chunk
    // importing from `_5.js` — no `chunk-` anywhere — is still the split era.
    const importer = chunkRegion(`import{a as b}from"${BUNFS_MODULE_ROOT}_5.js";var c=1;`);
    const other = chunkRegion('export{d as a};var d=2;');
    const out = sliceEmbeddedChunks(artifact(importer, other), '2.1.246');
    expect(out).toEqual([importer, other]);
  });

  it('keeps the single-bundle era off the split path when the root appears only in strings', () => {
    // The pre-242 bundle references `/$bunfs/root/` in plain strings (a sourcemap path,
    // an asset name) but never IMPORTS from it. Keying on `from"` keeps it on the
    // single-bundle path — here a lone banner region with a bare-string reference.
    const bundle = jsRegion(true, 2, 'cli') + `\n// see "${BUNFS_MODULE_ROOT}sourcemap.json"`;
    const out = sliceEmbeddedChunks(artifact(bundle));
    expect(out).toEqual([sliceEmbeddedBundle(artifact(bundle))]);
    expect(out).toHaveLength(1);
  });
});
