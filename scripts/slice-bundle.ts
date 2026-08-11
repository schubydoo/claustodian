// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract the embedded JavaScript from a Bun-compiled release artifact.
 *
 * WHY THIS EXISTS. From 2.1.113 the release stopped being an npm tarball holding
 * `package/cli.js` and became a single compiled executable — 284 MiB at 2.1.226 —
 * with the CLI bundle embedded inside it alongside unrelated vendored assets. The
 * regex lanes never needed this: searching a blob for `.option("--foo")` finds the
 * match whatever surrounds it. A PARSER does need it, because it reads the input as
 * one program and binary wrapper bytes are not JavaScript. So this is the
 * prerequisite for any AST-based lane, and only for the compiled era.
 *
 * ⚠️ This deliberately does NOT change what the regex lanes see. They run against
 * the raw artifact today, and feeding them a slice instead would drop whatever they
 * currently match outside the CLI bundle — a change to published data, which is not
 * this module's business to make.
 *
 * HOW THE REGION IS IDENTIFIED, and why that is not a guess. Measured across the
 * compiled era (2.1.113, 2.1.143, 2.1.172, 2.1.203, 2.1.226 — five points spanning
 * all 98 archived compiled versions): the CLI bundle is the largest run of
 * printable bytes in the file AND it begins with a stable Bun banner. At 2.1.226
 * the runs after it are vendored libraries — mermaid (2.14 MiB), highlight.js
 * (1.02), a generated hljs bundle (0.94), Chart.js (0.20) — and none contains a
 * single control-protocol marker.
 *
 * The banner is the primary signal and size is the tie-break, not the other way
 * round: "largest" alone would silently follow a future release that vendors
 * something bigger than the CLI.
 *
 * WHAT IT REFUSES TO DO. Return something it is not sure about. A slicer that picks
 * the wrong region does not fail — it silently extracts from the wrong bytes and
 * every downstream count is quietly wrong. So a candidate must carry the banner or
 * be decisively the largest, must clear a plausibility floor, and the caller is
 * expected to parse it (which is itself a check: the CLI bundle parses with zero
 * errors, arbitrary binary does not).
 */

/** The Bun compiled-bundle banner, byte-identical across every version measured. */
export const BUN_BANNER = '// @bun';

/**
 * Smallest plausible CLI bundle. The oldest compiled release measured (2.1.113) is
 * 12.4 MiB and they only grow; 1 MiB is far below that and still far above any
 * accidental run of printable bytes, so it separates "found the bundle" from "found
 * noise" without tracking the real size.
 */
const MIN_PLAUSIBLE_BYTES = 1 * 1024 * 1024;

/** A printable byte: ASCII text, the usual whitespace, or any UTF-8 continuation. */
function isPrintable(byte: number): boolean {
  return (
    (byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte >= 0x80
  );
}

/**
 * The banner-carrying run if there is one, otherwise the longest.
 *
 * Single pass, holding two candidates. An earlier revision collected every maximal
 * run and sorted them, which exhausts the heap on a 284 MiB artifact — there are
 * millions of short runs between the embedded assets, and none of them could ever
 * win.
 */
function selectRegion(bytes: Uint8Array): { start: number; end: number } | undefined {
  let longest: { start: number; end: number } | undefined;
  let banner: { start: number; end: number } | undefined;

  const consider = (start: number, end: number): void => {
    if (banner) return; // the banner run wins outright; stop paying for comparisons
    if (!longest || end - start > longest.end - longest.start) longest = { start, end };
    // Decode only the head — enough to recognise the banner, cheap per run.
    if (end - start >= MIN_PLAUSIBLE_BYTES) {
      const head = Buffer.from(bytes.subarray(start, Math.min(end, start + 64))).toString('utf-8');
      if (head.startsWith(BUN_BANNER)) banner = { start, end };
    }
  };

  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i < bytes.length && isPrintable(bytes[i] as number)) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1) consider(start, i);
    start = -1;
  }
  return banner ?? longest;
}

/**
 * True when `raw` is already JavaScript rather than a compiled artifact — the
 * npm-tarball era, where the caller extracted `package/cli.js` and there is nothing
 * to slice.
 *
 * Checked on the BYTES rather than a decoded string: decoding a binary as UTF-8
 * first turns every invalid sequence into U+FFFD, which is not a control character
 * and would make a 284 MiB executable look like one continuous run of text.
 */
export function looksLikeSource(bytes: Uint8Array): boolean {
  // A compiled artifact has NUL bytes in its first few KiB; a JS file does not.
  const window = bytes.subarray(0, Math.min(bytes.length, 8192));
  return !window.includes(0);
}

/**
 * The embedded CLI bundle as text, or `raw` unchanged when it is already source.
 *
 * @throws when the artifact is compiled but no plausible bundle can be located —
 * never returns the raw artifact as a fallback, because a parser would then reject
 * it and the failure would be reported against the wrong cause.
 */
export function sliceEmbeddedBundle(bytes: Uint8Array, label = 'artifact'): string {
  if (looksLikeSource(bytes)) return Buffer.from(bytes).toString('utf-8');

  const chosen = selectRegion(bytes);
  if (!chosen) {
    throw new Error(
      `slice-bundle: ${label} contains no printable runs at all. It is not a ` +
        `release artifact this can read.`
    );
  }

  const size = chosen.end - chosen.start;
  if (size < MIN_PLAUSIBLE_BYTES) {
    throw new Error(
      `slice-bundle: the largest printable run in ${label} is ${size} bytes, below ` +
        `the ${MIN_PLAUSIBLE_BYTES}-byte floor for a CLI bundle. Refusing to return ` +
        `it — extracting from the wrong region reports wrong counts rather than failing.`
    );
  }
  return Buffer.from(bytes.subarray(chosen.start, chosen.end)).toString('utf-8');
}
