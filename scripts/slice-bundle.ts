// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

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
 * Selection is by banner ONLY. Size is a floor, not a ranking, and there is no
 * fallback to "largest run": "largest" alone would silently follow a future release
 * that vendors something bigger than the CLI. Absence of a banner is a refusal.
 *
 * More than one banner region is normal — 2.1.113 embeds the CLI bundle TWICE, as
 * two identical 12.39 MiB regions at different offsets — and is accepted only while
 * the copies are byte-identical. If they diverge, file order is not evidence for
 * which one the CLI runs, so that is a refusal too.
 *
 * WHY THE API TAKES BYTES. Not because decoding would merge the regions — an
 * earlier revision claimed that and it is false, since `isPrintable` already accepts
 * every byte >= 0x80 and UTF-8 decoding never alters a byte below 0x20, so run
 * boundaries survive a round trip. The real reasons are narrower: offsets stay
 * byte-exact rather than becoming code-unit indices, a digest can be taken over a
 * subarray without re-encoding, and a 284 MiB artifact is never materialised as a
 * JS string.
 *
 * WHAT IT REFUSES TO DO. Return something it is not sure about. A slicer that picks
 * the wrong region does not fail — it silently extracts from the wrong bytes and
 * every downstream count is quietly wrong. So a candidate must carry the banner AND
 * clear a plausibility floor — there is no "largest" fallback at all — and the
 * caller is expected to parse it, which is itself a check: the CLI bundle parses
 * with zero errors, arbitrary binary does not.
 */

/** The Bun compiled-bundle banner, byte-identical across every version measured. */
export const BUN_BANNER = '// @bun';

/** The banner as bytes, so a run can be tested without decoding it. */
const BANNER_BYTES = Buffer.from(BUN_BANNER, 'utf-8');

/**
 * Smallest plausible CLI bundle. This is the size of the EMBEDDED bundle, not of
 * the artifact around it: the smallest measured is 12.39 MiB at 2.1.113, inside a
 * 225 MiB artifact. 1 MiB sits far below every measured bundle and far above any
 * accidental run of printable bytes, so it separates "found the bundle" from "found
 * a marker" without tracking a real size that would need revisiting each release.
 */
const MIN_PLAUSIBLE_BYTES = 1 * 1024 * 1024;

/** A printable byte: ASCII text, the usual whitespace, or any UTF-8 continuation. */
function isPrintable(byte: number): boolean {
  return (
    (byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte >= 0x80
  );
}

/**
 * Every maximal printable run that carries the banner and clears the size floor.
 *
 * Single pass holding only candidates. An earlier revision collected every run and
 * sorted them, which exhausts the heap on a 284 MiB artifact — there are millions
 * of short runs between the embedded assets and none could ever win.
 *
 * It returns ALL banner runs rather than the first, because artifacts really do
 * carry more than one: 2.1.113 embeds the CLI bundle TWICE, two identical 12.39 MiB
 * regions at different offsets. Taking the first would be picking by file position.
 */
function bannerRuns(bytes: Uint8Array): {
  candidates: Array<{ start: number; end: number }>;
  /** Banner-carrying runs rejected by the floor, so the caller can say which it was. */
  undersized: number;
} {
  const found: Array<{ start: number; end: number }> = [];
  let undersized = 0;
  // Compared as BYTES, not by decoding a head. This runs once per printable run and
  // there are millions of them in a 284 MiB artifact, so allocating a Buffer and
  // decoding it per run is the difference between a second and a stall. It also
  // means the banner test can come first and still be cheap, which is what lets the
  // floor report "banner present but too small" separately.
  const startsWithBanner = (start: number, end: number): boolean => {
    if (end - start < BANNER_BYTES.length) return false;
    for (let i = 0; i < BANNER_BYTES.length; i += 1) {
      if (bytes[start + i] !== BANNER_BYTES[i]) return false;
    }
    return true;
  };

  const consider = (start: number, end: number): void => {
    if (!startsWithBanner(start, end)) return;
    if (end - start < MIN_PLAUSIBLE_BYTES) {
      undersized += 1;
      return;
    }
    found.push({ start, end });
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
  return { candidates: found, undersized };
}

/** Content digest, so duplicate embedded copies can be told from differing ones. */
function digest(bytes: Uint8Array, start: number, end: number): string {
  return createHash('sha256').update(bytes.subarray(start, end)).digest('hex');
}

/**
 * True when `bytes` is already JavaScript rather than a compiled artifact — the
 * npm-tarball era, where the caller extracted `package/cli.js` and there is nothing
 * to slice.
 *
 */
export function looksLikeSource(bytes: Uint8Array): boolean {
  // A compiled artifact has NUL bytes in its first few KiB; a JS file does not.
  const window = bytes.subarray(0, Math.min(bytes.length, 8192));
  return !window.includes(0);
}

/**
 * The embedded CLI bundle as text, or `bytes` decoded unchanged when it is already
 * source.
 *
 * @throws when the artifact is compiled but no banner region can be located, or
 * when several disagree. It does not fall back to returning a region it is unsure
 * of.
 *
 * ⚠️ It CAN still return the raw input, in one case: when `looksLikeSource` judges
 * the input to be source already. That judgement is a negative test — no NUL byte
 * in the first 8 KiB — so an artifact that happened to lack one there would be
 * passed through whole. That failure is loud rather than silent, but it surfaces one
 * step later, at the caller's parser, which will reject it and blame the bundle.
 */
export function sliceEmbeddedBundle(bytes: Uint8Array, label = 'artifact'): string {
  // Aliases rather than copies: this path can receive a whole artifact, and
  // `Buffer.from(uint8array)` would duplicate every byte of it.
  if (looksLikeSource(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf-8');
  }

  const { candidates, undersized } = bannerRuns(bytes);

  // Two distinct causes, told apart, because they mean different things to whoever
  // reads the failure: a banner that is present but tiny is a marker in some other
  // asset, while no banner at all means this is not an artifact shape this
  // understands. Neither falls back to "largest run" — guessing by size is exactly
  // how a release vendoring something bigger than the CLI would be extracted from
  // the wrong region without failing.
  if (candidates.length === 0 && undersized > 0) {
    throw new Error(
      `slice-bundle: ${undersized} region(s) in ${label} begin with "${BUN_BANNER}" but ` +
        `none clears the ${MIN_PLAUSIBLE_BYTES}-byte floor. The smallest bundle measured ` +
        `is 12.39 MiB, so that is a marker elsewhere, not the CLI. Refusing.`
    );
  }
  if (candidates.length === 0) {
    throw new Error(
      `slice-bundle: no region in ${label} begins with "${BUN_BANNER}". Refusing rather ` +
        `than guessing by size: picking the wrong region reports wrong counts instead ` +
        `of failing.`
    );
  }

  // More than one is normal — 2.1.113 embeds the bundle twice — but only while the
  // copies are identical. If they ever diverge, "first in the file" is not a reason
  // to prefer one, so say so rather than choose.
  const first = candidates[0] as { start: number; end: number };
  if (candidates.length > 1) {
    const reference = digest(bytes, first.start, first.end);
    const differing = candidates
      .slice(1)
      .filter((run) => digest(bytes, run.start, run.end) !== reference);
    if (differing.length > 0) {
      throw new Error(
        `slice-bundle: ${label} carries ${candidates.length} banner regions and they ` +
          `are not identical (sizes ${candidates.map((r) => r.end - r.start).join(', ')}). ` +
          `Refusing — file order is not evidence for which one the CLI runs.`
      );
    }
  }

  return Buffer.from(bytes.subarray(first.start, first.end)).toString('utf-8');
}
