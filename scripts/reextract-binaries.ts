// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — archive re-extraction (step 2 of the binary pipeline). Runs
 * `extract-bundle` over every archived Claude Code binary and writes one
 * per-version cache file `<out>/<version>.json` for `scripts/backfill-binary.ts`
 * to distill into `data/binary-observations.json`.
 *
 * Run this after an `extract-bundle.ts` change to regenerate the cache with the
 * new extractor before backfilling — that is what turns an extractor fix into
 * actual coverage (earlier first_seen, cleared false-removals, new symbols).
 *
 * OFFICIAL SOURCES ONLY. A version is extracted only when its bundle hashes to
 * the release's committed `SHA256SUMS`:
 *   - npm packages (≤2.1.112): `<version>/bundle.tgz` → `package/cli.js` / `cli.mjs`;
 *   - compiled releases (≥2.1.113): `<version>/linux-x64/claude` (embedded bundle).
 * A patched, copied, or otherwise non-release bundle fails the checksum and is
 * refused, so nothing outside the provenance boundary can be cached as
 * `source:"binary"`. A locally-installed binary is likewise never a source.
 *
 * Each run regenerates the WHOLE cache atomically, but only inside a dedicated
 * cache directory (empty, or holding only `<version>.json` + `_`-sidecars): it
 * removes every file the backfill loader reads (all non-`_`-prefixed `*.json`,
 * matching `loadCacheFiles`), then writes fresh — so a stray file or old-extractor
 * output can never mix, and a mistyped `--out` cannot delete unrelated files.
 * The ~139 GB archive is a maintainer-local artifact; see scratch/backfill-notes.md.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractControlMessages } from './control-lane.js';
import { sliceEmbeddedBundle } from './slice-bundle.js';
import { extractBundleSymbols } from './extract-bundle.js';
import { compareVersionsAsc, isMain } from './lib.js';
import type { ControlMessageObservation } from './control-lane.js';

const DEFAULT_ARCHIVE_DIR = 'scratch/binaries';
const DEFAULT_OUT_DIR = 'binary-cache';
/** cli.js can be large; allow up to 1 GiB when streaming it out of the tarball. */
const TAR_MAX_BUFFER = 1 << 30;
/** A strict `major.minor.patch` — rejects junk version input early. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Resolving one archived version's source: extractable, absent, or not official. */
/**
 * A dirty flag on the cache directory: present means "this cache is NOT known to be
 * complete", absent means a run finished and wrote every version it considered.
 *
 * ⚠️ Raised BEFORE `clearCache`, lowered only on a clean finish. Written at the end
 * instead, it would miss anything that kills the process mid-run — the cache is
 * already incomplete by then.
 *
 * `_`-prefixed so `clearCache` preserves it and `loadCacheFiles` skips it.
 */
export const CACHE_INCOMPLETE_MARKER = '_cache-incomplete.json';

/** Writes the marker. One writer, so every state records the same shape. */
function writeMarker(outDir: string, payload: Record<string, unknown> & { status: string }): void {
  writeFileSync(join(outDir, CACHE_INCOMPLETE_MARKER), JSON.stringify(payload, null, 2));
}

export type BundleResult =
  | {
      kind: 'ok';
      /** What the regex lanes read: the artifact decoded, unchanged and unsliced. */
      src: string;
      /**
       * The undecoded artifact, present ONLY for the compiled era. A parser cannot
       * read `src` there — it is a whole executable — so the AST lane slices this
       * instead. Absent for npm tarballs, where `src` is already `package/cli.js`.
       */
      bytes?: Buffer;
    }
  | { kind: 'missing' }
  | { kind: 'unverified'; file: string };

/** The official SHA-256 for `relPath` from a version dir's `SHA256SUMS`, if any. */
function officialSha(versionDir: string, relPath: string): string | undefined {
  const sums = join(versionDir, 'SHA256SUMS');
  if (!existsSync(sums)) return undefined;
  for (const line of readFileSync(sums, 'utf-8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m && m[2]?.trim() === relPath) return m[1];
  }
  return undefined;
}

/** True when `file`'s SHA-256 matches the release's committed checksum. */
function isOfficial(file: string, versionDir: string, relPath: string): boolean {
  const want = officialSha(versionDir, relPath);
  if (!want) return false; // no committed checksum → not a verifiable official artifact
  return createHash('sha256').update(readFileSync(file)).digest('hex') === want;
}

/**
 * Resolves one archived version's bundle source, ONLY from a checksum-verified
 * official artifact. Returns `unverified` (with the offending file) when a bundle
 * exists but does not match `SHA256SUMS`, and `missing` when no bundle is present.
 */
export function readBundleSource(archiveDir: string, version: string): BundleResult {
  if (!VERSION_RE.test(version)) return { kind: 'missing' }; // reject junk version input
  const dir = join(archiveDir, version);

  const tarball = join(dir, 'bundle.tgz');
  if (existsSync(tarball)) {
    if (!isOfficial(tarball, dir, 'bundle.tgz')) return { kind: 'unverified', file: tarball };
    for (const entry of ['package/cli.js', 'package/cli.mjs']) {
      try {
        // execFileSync (no shell) — archiveDir may contain spaces or metacharacters
        // utf-8: the bundle text is UTF-8; latin1 mangled non-ASCII in extracted
        // descriptions (e.g. "·"→"Â·", "–"→"â") — see the description timeline.
        const src = execFileSync('tar', ['xzOf', tarball, entry], {
          maxBuffer: TAR_MAX_BUFFER,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return { kind: 'ok', src };
      } catch {
        // entry not in this tarball — try the next candidate
      }
    }
    return { kind: 'missing' }; // official tarball but no cli entry
  }

  const compiled = join(dir, 'linux-x64', 'claude');
  if (existsSync(compiled)) {
    if (!isOfficial(compiled, dir, 'linux-x64/claude'))
      return { kind: 'unverified', file: compiled };
    // Read once as bytes and decode from that, rather than reading twice: `src`
    // must stay byte-for-byte what the regex lanes have always seen.
    const bytes = readFileSync(compiled);
    return { kind: 'ok', src: bytes.toString('utf-8'), bytes };
  }

  return { kind: 'missing' };
}

interface CliOptions {
  archiveDir: string;
  outDir: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { archiveDir: DEFAULT_ARCHIVE_DIR, outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value (e.g. "${arg} <value>").`);
      if (arg === '--archive') options.archiveDir = value;
      else options.outDir = value;
      i++;
    } else {
      throw new Error(`Unknown argument "${arg}". Expected --archive or --out.`);
    }
  }
  return options;
}

/** Archived version dirs, oldest-first. */
export function selectVersions(archiveDir: string): string[] {
  return readdirSync(archiveDir)
    .filter((name) => VERSION_RE.test(name))
    .sort(compareVersionsAsc);
}

/**
 * True when `outDir` is a dedicated binary cache safe to clear: empty, or holding
 * only `<version>.json` cache files and `_`-prefixed sidecars. Any other content
 * (e.g. a mistyped `--out data`) makes this false so `clearCache` refuses.
 */
export function isDedicatedCache(outDir: string): boolean {
  for (const name of readdirSync(outDir)) {
    if (name.startsWith('_')) continue;
    if (name.endsWith('.json') && VERSION_RE.test(name.slice(0, -'.json'.length))) continue;
    return false;
  }
  return true;
}

/** Removes every file the backfill loader reads (all non-`_`-prefixed `*.json`). */
function clearCache(outDir: string): void {
  for (const name of readdirSync(outDir)) {
    if (name.endsWith('.json') && !name.startsWith('_')) rmSync(join(outDir, name));
  }
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  mkdirSync(options.outDir, { recursive: true });
  const versions = selectVersions(options.archiveDir);
  if (versions.length === 0) {
    throw new Error(
      `No archived versions in ${options.archiveDir}. ` +
        `The binary archive is a maintainer-local artifact (see scratch/backfill-notes.md).`
    );
  }
  if (!isDedicatedCache(options.outDir)) {
    throw new Error(
      `Refusing to regenerate the cache in ${options.outDir}: it holds non-cache files. ` +
        `Point --out at an empty directory or a prior reextract-binaries cache.`
    );
  }
  writeMarker(options.outDir, {
    status: 'in-progress',
    note:
      'reextract-binaries cleared this cache and has not finished repopulating it. ' +
      'Do not backfill from it. Removed automatically by a run that writes every ' +
      'version it selects and has no outstanding losses.',
    versionsConsidered: versions.length,
  });

  clearCache(options.outDir);

  let extracted = 0;
  const missing: string[] = [];
  const unverified: string[] = [];
  // Collected rather than thrown: one bad bundle must not abort a 470-version loop,
  // and the run reports every failure at the end instead of only the first.
  const controlFailures: Array<{ version: string; reason: string }> = [];
  for (const version of versions) {
    const result = readBundleSource(options.archiveDir, version);
    if (result.kind === 'missing') {
      missing.push(version);
      continue;
    }
    if (result.kind === 'unverified') {
      unverified.push(version);
      continue;
    }
    const symbols = extractBundleSymbols(result.src);
    // Deliberately uninitialised: the catch `continue`s, so an initial value would
    // never be read, and a default of `[]` here is exactly the silent-zero this lane
    // exists to refuse.
    let controlMessages: ControlMessageObservation[];
    try {
      // The compiled era hands us an executable, which no parser can read. Slice the
      // embedded bundle out for the AST lane; the npm era is already source, and
      // `src` is what the regex lanes keep seeing either way.
      const parseable = result.bytes ? sliceEmbeddedBundle(result.bytes, version) : result.src;
      controlMessages = extractControlMessages(parseable, version);
    } catch (error) {
      controlFailures.push({ version, reason: (error as Error).message });
      continue;
    }
    writeFileSync(
      join(options.outDir, `${version}.json`),
      JSON.stringify({
        version,
        source: 'binary',
        count: symbols.length,
        symbols,
        controlCount: controlMessages.length,
        controlMessages,
      })
    );
    extracted++;
  }

  const notes: string[] = [];
  if (missing.length)
    notes.push(`${missing.length} without a readable binary: ${missing.join(', ')}`);
  if (unverified.length) {
    notes.push(
      `${unverified.length} refused (checksum mismatch or missing SHA256SUMS): ${unverified.join(', ')}`
    );
  }
  console.log(
    `Re-extracted ${extracted}/${versions.length} version(s) into ${options.outDir}` +
      (notes.length ? `; ${notes.join('; ')}` : '.')
  );

  // A non-zero exit, and every failure named. A control-lane refusal means that
  // version's control symbols are ABSENT from the cache, and absence downstream
  // reads as a removal — so this cannot be a warning the caller might miss.
  if (controlFailures.length > 0) {
    // Replaces the in-progress note with why the flag is staying. `return 1` alone
    // is not enough: the next runbook step is a separate command, and a partly-written
    // cache looks plausible to `loadCacheFiles`, which only refuses an empty one.
    writeMarker(options.outDir, {
      status: 'refused',
      note:
        'These versions have no cache entry. Backfilling would report their symbols ' +
        'as removed. Fix the refusals and re-run reextract-binaries.',
      versionsConsidered: versions.length,
      refused: controlFailures.length,
      failures: controlFailures,
    });
    console.error(
      `\ncontrol lane refused ${controlFailures.length} version(s); their entries were ` +
        `NOT written, so the cache is incomplete and must not be backfilled from:\n` +
        controlFailures.map((f) => `  ${f.version}: ${f.reason}`).join('\n')
    );
    return 1;
  }

  // Lowered only when nothing was skipped — `missing` (no readable bundle) or
  // `unverified` (checksum mismatch, refused). Either way the cache entry was
  // cleared and never rewritten; the
  // flag stops a backfill distilling that absence as a removal. Exit code unchanged.
  //
  // ⚠️ NOT covered: a version in the cache but absent from the archive is never
  // selected, so this cannot see it. `scripts/check-version-sets.sh` catches that
  // before step 1 and the runbook requires it.
  const skipped = missing.length + unverified.length;
  if (skipped > 0) {
    writeMarker(options.outDir, {
      status: 'skipped',
      note:
        'These versions were selected from the archive but not written — `missing` has ' +
        'no readable bundle, `unverified` failed its checksum. Their prior cache ' +
        'entries were cleared and not rewritten. Restore each artifact, with its ' +
        'SHA256SUMS entry, under ' +
        'scratch/binaries/<version>/ and re-run. `scrape-binary --force` does not help: ' +
        'it writes binary-cache/, which step 1 clears before re-reading the archive.',
      versionsConsidered: versions.length,
      missing,
      unverified,
    });
    console.error(
      `\n${skipped} version(s) are missing from the cache; ` +
        `${CACHE_INCOMPLETE_MARKER} is left in place and backfill will refuse until a run ` +
        `writes every version.`
    );
    return 0;
  }

  // Only here: every version considered was written, so the cache is complete.
  rmSync(join(options.outDir, CACHE_INCOMPLETE_MARKER), { force: true });
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error('Unexpected error while re-extracting binaries:', error);
      process.exitCode = 1;
    });
}
