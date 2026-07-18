// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCacheRecord, main, parseArgs, resolveVersion, scrapeBinary } from './scrape-binary.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A minimal commander `.option` spec the extractor recognizes, so a fake bundle
 * yields at least one own-evidenced symbol (proves extraction ran on our bytes). */
const FAKE_BUNDLE = `.option("--demo-flag","a demonstration flag")`;

/** Fake a CDN manifest + binary response pair, keyed by URL substring. */
function stubCdn(version: string, binary: string, checksum: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/manifest.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version, platforms: { 'linux-x64': { binary: 'claude', checksum, size: binary.length } } }),
        } as unknown as Response;
      }
      if (url.endsWith('/linux-x64/claude')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode(binary).buffer,
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseArgs', () => {
  it('defaults to the committed binary-cache dir and no forced re-scrape', () => {
    expect(parseArgs([])).toEqual({ outDir: 'binary-cache', force: false });
  });

  it('parses --version, --out, and --force', () => {
    expect(parseArgs(['--version', '2.1.214', '--out', '/tmp/x', '--force'])).toEqual({
      version: '2.1.214',
      outDir: '/tmp/x',
      force: true,
    });
  });

  it('throws on an unknown argument', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  it('throws when a value-taking flag has no value', () => {
    expect(() => parseArgs(['--version'])).toThrow(/requires a value/);
  });
});

describe('resolveVersion', () => {
  it('prefers an explicit version', () => {
    expect(resolveVersion('2.1.214')).toBe('2.1.214');
  });

  it('falls back to index.json latest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    const indexPath = join(dir, 'index.json');
    await writeFile(indexPath, JSON.stringify({ latest: '2.1.208' }));
    expect(resolveVersion(undefined, indexPath)).toBe('2.1.208');
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a malformed version', () => {
    expect(() => resolveVersion('v2.1')).toThrow(/No valid version/);
  });
});

describe('buildCacheRecord', () => {
  it('produces the same shape reextract-binaries writes', () => {
    const record = buildCacheRecord('2.1.214', FAKE_BUNDLE);
    expect(record.version).toBe('2.1.214');
    expect(record.source).toBe('binary');
    expect(record.count).toBe(record.symbols.length);
    expect(record.symbols.some((s) => s.symbol === '--demo-flag')).toBe(true);
  });
});

describe('scrapeBinary', () => {
  it('downloads, verifies the checksum, and writes a cache file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    stubCdn('2.1.214', FAKE_BUNDLE, sha256(FAKE_BUNDLE));

    const result = await scrapeBinary({ version: '2.1.214', outDir: dir, force: false });
    expect(result).not.toBe('skip');
    const written = JSON.parse(await readFile(join(dir, '2.1.214.json'), 'utf-8'));
    expect(written.version).toBe('2.1.214');
    expect(written.source).toBe('binary');
    expect(written.count).toBe(written.symbols.length);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a binary whose checksum does not match the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    stubCdn('2.1.214', FAKE_BUNDLE, sha256('a different artifact')); // wrong checksum

    await expect(scrapeBinary({ version: '2.1.214', outDir: dir, force: false })).rejects.toThrow(
      /checksum mismatch/
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a manifest whose version does not match the requested one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    stubCdn('2.1.999', FAKE_BUNDLE, sha256(FAKE_BUNDLE)); // manifest self-reports 2.1.999
    await expect(scrapeBinary({ version: '2.1.214', outDir: dir, force: false })).rejects.toThrow(
      /manifest identifies release "2\.1\.999"/
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('retries a transient network throw, then succeeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/manifest.json')) {
          calls++;
          if (calls === 1) throw new Error('network down'); // transient throw → retried
          return { ok: true, status: 200, json: async () => ({ version: '2.1.214', platforms: { 'linux-x64': { binary: 'claude', checksum: sha256(FAKE_BUNDLE), size: FAKE_BUNDLE.length } } }) } as unknown as Response;
        }
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(FAKE_BUNDLE).buffer } as unknown as Response;
      })
    );
    const result = await scrapeBinary({ version: '2.1.214', outDir: dir, force: false });
    expect(result).not.toBe('skip');
    expect(calls).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when the release has no compiled binary (manifest 404)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));

    await expect(scrapeBinary({ version: '9.9.9', outDir: dir, force: false })).rejects.toThrow(
      /no compiled release/
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('skips when the cache file already exists and --force is not set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    await writeFile(join(dir, '2.1.214.json'), '{"version":"2.1.214","source":"binary","count":0,"symbols":[]}');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await scrapeBinary({ version: '2.1.214', outDir: dir, force: false });
    expect(result).toBe('skip');
    expect(fetchSpy).not.toHaveBeenCalled(); // no network when skipping
    await rm(dir, { recursive: true, force: true });
  });

  it('re-scrapes an existing version when --force is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    await writeFile(join(dir, '2.1.214.json'), '{"stale":true}');
    stubCdn('2.1.214', FAKE_BUNDLE, sha256(FAKE_BUNDLE));

    const result = await scrapeBinary({ version: '2.1.214', outDir: dir, force: true });
    expect(result).not.toBe('skip');
    const written = JSON.parse(await readFile(join(dir, '2.1.214.json'), 'utf-8'));
    expect(written.source).toBe('binary');
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when the manifest lacks the linux-x64 platform', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ version: '2.1.214', platforms: {} }) }) as unknown as Response)
    );
    await expect(scrapeBinary({ version: '2.1.214', outDir: dir, force: false })).rejects.toThrow(
      /no "linux-x64" platform/
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when the binary download fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/manifest.json')
          ? ({ ok: true, status: 200, json: async () => ({ version: '2.1.214', platforms: { 'linux-x64': { binary: 'claude', checksum: 'x', size: 1 } } }) } as unknown as Response)
          : ({ ok: false, status: 403 } as unknown as Response)
      )
    );
    await expect(scrapeBinary({ version: '2.1.214', outDir: dir, force: false })).rejects.toThrow(
      /binary fetch failed \(HTTP 403\)/
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when the manifest fetch fails with a non-404 status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response));
    await expect(scrapeBinary({ version: '2.1.214', outDir: dir, force: false })).rejects.toThrow(
      /manifest fetch failed \(HTTP 403\)/
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('retries a transient 5xx on the manifest, then succeeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    let manifestCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/manifest.json')) {
          manifestCalls++;
          if (manifestCalls === 1) return { ok: false, status: 503 } as unknown as Response;
          return { ok: true, status: 200, json: async () => ({ version: '2.1.214', platforms: { 'linux-x64': { binary: 'claude', checksum: sha256(FAKE_BUNDLE), size: FAKE_BUNDLE.length } } }) } as unknown as Response;
        }
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(FAKE_BUNDLE).buffer } as unknown as Response;
      })
    );
    const result = await scrapeBinary({ version: '2.1.214', outDir: dir, force: false });
    expect(result).not.toBe('skip');
    expect(manifestCalls).toBe(2); // first 503 retried
    await rm(dir, { recursive: true, force: true });
  });
});

describe('main', () => {
  it('runs the scrape end-to-end and returns 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrape-bin-'));
    stubCdn('2.1.214', FAKE_BUNDLE, sha256(FAKE_BUNDLE));
    const code = await main(['--version', '2.1.214', '--out', dir]);
    expect(code).toBe(0);
    const written = JSON.parse(await readFile(join(dir, '2.1.214.json'), 'utf-8'));
    expect(written.version).toBe('2.1.214');
    await rm(dir, { recursive: true, force: true });
  });
});
