// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — CI tip extractor. Fetches a SINGLE release's compiled binary
 * from the official CDN, verifies it against the release manifest, extracts its
 * symbols with the same `extract-bundle` extractor the archive re-extraction
 * uses, and writes one per-version cache file `<out>/<version>.json`.
 *
 * This is the CI-friendly counterpart to `scripts/reextract-binaries.ts`: that
 * runner needs the ~139 GB maintainer-local archive to regenerate the WHOLE
 * cache, which no runner can hold. This script needs only the one new release
 * (~250 MB), so the hourly release detector can keep the committed binary cache
 * current on its own — after which `scripts/backfill-binary.ts` re-distills the
 * committed `binary-cache/` into `data/binary-observations.json` with no archive.
 *
 * OFFICIAL SOURCES ONLY. The downloaded binary must hash to the checksum the
 * release's own `manifest.json` publishes, or it is refused — the same
 * provenance boundary `reextract-binaries` enforces via `SHA256SUMS`. The cache
 * file it writes is byte-identical to what a full archive re-extraction of the
 * same version produces, so the two paths are interchangeable inputs to the
 * backfill.
 *
 * Forward-only: it extracts the tip and appends/refreshes that version's cache
 * file. Historical corrections (pushing a `first_seen` earlier, re-extracting
 * after an `extract-bundle` change) still require the maintainer-local full run.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBundleSymbols } from './extract-bundle.js';
import { isMain } from './lib.js';

/** The platform whose embedded bundle the extractor reads (matches reextract). */
const PLATFORM = 'linux-x64';
const CDN_BASE = 'https://downloads.claude.ai/claude-code-releases';
const DEFAULT_OUT_DIR = 'binary-cache';
const DEFAULT_INDEX_PATH = 'data/index.json';
/** A strict `major.minor.patch` — rejects junk version input early. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** One platform's entry in a release `manifest.json`. */
interface PlatformEntry {
  binary: string;
  checksum: string;
  size: number;
}
interface Manifest {
  version: string;
  platforms: Record<string, PlatformEntry>;
}

interface CliOptions {
  version?: string;
  outDir: string;
  force: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outDir: DEFAULT_OUT_DIR, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value (e.g. "${arg} <value>").`);
      if (arg === '--version') options.version = value;
      else options.outDir = value;
      i++;
    } else if (arg === '--force') {
      options.force = true;
    } else {
      throw new Error(`Unknown argument "${arg}". Expected --version, --out, or --force.`);
    }
  }
  return options;
}

/** The version to scrape: the CLI value, else `data/index.json`'s `latest`. */
export function resolveVersion(explicit: string | undefined, indexPath = DEFAULT_INDEX_PATH): string {
  const version = explicit ?? (JSON.parse(readFileSync(indexPath, 'utf-8')) as { latest?: string }).latest;
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`No valid version to scrape (got "${version ?? '<none>'}"). Pass --version X.Y.Z.`);
  }
  return version;
}

/** fetch with retries for transient errors (network throws, 5xx); 4xx returned as-is. */
async function fetchRetry(url: string, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'claustodian-scrape-binary' } });
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 2)));
  }
  throw lastErr;
}

/** The cache-file record for `version`, byte-identical to a full re-extraction. */
export function buildCacheRecord(version: string, bundle: string): BinaryCacheRecord {
  const symbols = extractBundleSymbols(bundle);
  return { version, source: 'binary', count: symbols.length, symbols };
}

export interface BinaryCacheRecord {
  version: string;
  source: 'binary';
  count: number;
  symbols: ReturnType<typeof extractBundleSymbols>;
}

/** Write `record` to `<outDir>/<version>.json` atomically (tmp + rename). */
function writeCacheFile(outDir: string, record: BinaryCacheRecord): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${record.version}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, path);
  return path;
}

export async function scrapeBinary(options: CliOptions): Promise<{ path: string; count: number } | 'skip'> {
  const version = resolveVersion(options.version);
  const outPath = join(options.outDir, `${version}.json`);
  if (existsSync(outPath) && !options.force) {
    console.log(`${version}: cache file already present (${outPath}); pass --force to re-scrape. Skipping.`);
    return 'skip';
  }

  const manifestRes = await fetchRetry(`${CDN_BASE}/${version}/manifest.json`);
  if (manifestRes.status === 404) {
    throw new Error(`${version}: no compiled release on the CDN (manifest 404). Nothing to scrape.`);
  }
  if (!manifestRes.ok) throw new Error(`${version}: manifest fetch failed (HTTP ${manifestRes.status}).`);
  const manifest = (await manifestRes.json()) as Manifest;

  const entry = manifest.platforms?.[PLATFORM];
  if (!entry) throw new Error(`${version}: manifest has no "${PLATFORM}" platform to extract from.`);

  const binRes = await fetchRetry(`${CDN_BASE}/${version}/${PLATFORM}/${entry.binary}`);
  if (!binRes.ok) throw new Error(`${version}/${PLATFORM}: binary fetch failed (HTTP ${binRes.status}).`);
  const buf = Buffer.from(await binRes.arrayBuffer());

  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== entry.checksum) {
    throw new Error(
      `${version}/${PLATFORM}: checksum mismatch — refusing (got ${got.slice(0, 12)}, ` +
        `manifest ${entry.checksum.slice(0, 12)}). Not a verified official artifact.`
    );
  }

  const record = buildCacheRecord(version, buf.toString('utf-8'));
  const path = writeCacheFile(options.outDir, record);
  console.log(`${version}: extracted ${record.count} symbol(s) → ${path} (checksum verified).`);
  return { path, count: record.count };
}

export async function main(argv: string[]): Promise<number> {
  await scrapeBinary(parseArgs(argv));
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error('scrape-binary failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
