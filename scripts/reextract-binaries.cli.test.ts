// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isDedicatedCache,
  main,
  parseArgs,
  readBundleSource,
  selectVersions,
} from './reextract-binaries.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Writes a compiled `<version>/linux-x64/claude` bundle + a realistic multi-platform
 * SHA256SUMS (so the checksum lookup must skip non-matching lines to find ours). */
async function writeCompiled(archive: string, version: string, js: string): Promise<void> {
  await mkdir(join(archive, version, 'linux-x64'), { recursive: true });
  await writeFile(join(archive, version, 'linux-x64', 'claude'), js);
  await writeFile(
    join(archive, version, 'SHA256SUMS'),
    `${sha256('darwin')}  darwin-x64/claude\n${sha256(js)}  linux-x64/claude\n${sha256('win')}  win32-x64/claude.exe\n`
  );
}

describe('reextract-binaries parseArgs', () => {
  it('defaults to the maintainer-local archive and the committed cache dir', () => {
    expect(parseArgs([])).toEqual({ archiveDir: 'scratch/binaries', outDir: 'binary-cache' });
  });

  it('parses --archive and --out', () => {
    expect(parseArgs(['--archive', 'a', '--out', 'b'])).toEqual({ archiveDir: 'a', outDir: 'b' });
  });

  it('throws when a flag is missing its value', () => {
    expect(() => parseArgs(['--out'])).toThrow(/--out requires a value/);
  });

  it('throws on an unknown flag instead of silently ignoring it', () => {
    expect(() => parseArgs(['--arhive', './data'])).toThrow(/Unknown argument "--arhive"/);
  });
});

describe('reextract-binaries readBundleSource', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('returns missing for a version with no bundle', () => {
    expect(readBundleSource('scratch/binaries', '9.9.9')).toEqual({ kind: 'missing' });
  });

  it('rejects a non-version string before touching the archive', () => {
    expect(readBundleSource('scratch/binaries', '$(touch pwned)')).toEqual({ kind: 'missing' });
  });

  it('extracts a checksum-verified compiled bundle', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-ok-'));
    await writeCompiled(root, '1.0.0', 'process.env.CLAUDE_CODE_OK;');
    expect(readBundleSource(root, '1.0.0')).toEqual({
      kind: 'ok',
      src: 'process.env.CLAUDE_CODE_OK;',
    });
  });

  it('refuses a bundle whose hash does not match SHA256SUMS', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-bad-'));
    await mkdir(join(root, '1.0.0', 'linux-x64'), { recursive: true });
    await writeFile(join(root, '1.0.0', 'linux-x64', 'claude'), 'process.env.CLAUDE_CODE_PATCHED;');
    await writeFile(
      join(root, '1.0.0', 'SHA256SUMS'),
      `${sha256('a different official build')}  linux-x64/claude\n`
    );
    expect(readBundleSource(root, '1.0.0')).toEqual({
      kind: 'unverified',
      file: join(root, '1.0.0', 'linux-x64', 'claude'),
    });
  });

  it('refuses a bundle with no SHA256SUMS at all', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-nosums-'));
    await mkdir(join(root, '1.0.0', 'linux-x64'), { recursive: true });
    await writeFile(join(root, '1.0.0', 'linux-x64', 'claude'), 'process.env.X;');
    expect(readBundleSource(root, '1.0.0').kind).toBe('unverified');
  });

  it('refuses when SHA256SUMS exists but lists no entry for the bundle', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-noentry-'));
    await mkdir(join(root, '1.0.0', 'linux-x64'), { recursive: true });
    await writeFile(join(root, '1.0.0', 'linux-x64', 'claude'), 'process.env.X;');
    await writeFile(join(root, '1.0.0', 'SHA256SUMS'), `${sha256('x')}  some-other-file\n`);
    expect(readBundleSource(root, '1.0.0').kind).toBe('unverified');
  });

  it('refuses a tarball whose hash does not match SHA256SUMS', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-badtgz-'));
    const pkg = join(root, 'pkg');
    await mkdir(join(pkg, 'package'), { recursive: true });
    await writeFile(join(pkg, 'package', 'cli.js'), 'process.env.X;');
    await mkdir(join(root, '1.0.0'), { recursive: true });
    const tgz = join(root, '1.0.0', 'bundle.tgz');
    execFileSync('tar', ['czf', tgz, '-C', pkg, 'package/cli.js']);
    await writeFile(join(root, '1.0.0', 'SHA256SUMS'), `${sha256('wrong')}  bundle.tgz\n`);
    expect(readBundleSource(root, '1.0.0')).toEqual({ kind: 'unverified', file: tgz });
  });

  it('returns missing for a verified tarball that carries no cli entry', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-nocli-'));
    const pkg = join(root, 'pkg');
    await mkdir(join(pkg, 'package'), { recursive: true });
    await writeFile(join(pkg, 'package', 'other.js'), 'x;'); // no cli.js / cli.mjs
    await mkdir(join(root, '1.0.0'), { recursive: true });
    const tgz = join(root, '1.0.0', 'bundle.tgz');
    execFileSync('tar', ['czf', tgz, '-C', pkg, 'package/other.js']);
    const hash = createHash('sha256')
      .update(await readFile(tgz))
      .digest('hex');
    await writeFile(join(root, '1.0.0', 'SHA256SUMS'), `${hash}  bundle.tgz\n`);
    expect(readBundleSource(root, '1.0.0')).toEqual({ kind: 'missing' });
  });
});

describe('reextract-binaries selectVersions / isDedicatedCache', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('lists only version-named entries, oldest-first', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-reextract-sel-'));
    for (const name of ['2.1.10', '2.1.2', '1.0.0', '_verify.log', 'notes.md']) {
      await mkdir(join(dir, name), { recursive: true });
    }
    expect(selectVersions(dir)).toEqual(['1.0.0', '2.1.2', '2.1.10']);
  });

  it('accepts an empty or cache-shaped dir, rejects one holding other files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-reextract-guard-'));
    expect(isDedicatedCache(dir)).toBe(true); // empty
    await writeFile(join(dir, '1.0.0.json'), '{}');
    await writeFile(join(dir, '_verify-report.json'), '{}');
    expect(isDedicatedCache(dir)).toBe(true); // version cache + sidecar
    await writeFile(join(dir, 'index.json'), '{}'); // non-version json (e.g. data/)
    expect(isDedicatedCache(dir)).toBe(false);
  });
});

describe('reextract-binaries main()', () => {
  let root: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('extracts verified bundles; reports missing and checksum-refused versions', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-main-'));
    const archive = join(root, 'archive');
    const out = join(root, 'out');
    await writeCompiled(archive, '1.0.0', 'if(process.env.CLAUDE_CODE_A)x();'); // ok
    // Valid JS, and carrying a control request: the control lane parses the bundle
    // and refuses a version at or above the dispatch floor that yields nothing, so a
    // fixture for this era has to be a real program rather than a fragment.
    await writeCompiled(
      archive,
      '2.0.0',
      'program.option("--foo <v>","desc");' +
        'function h(e){if(e.request.subtype==="initialize")return 1;return 0}'
    ); // ok
    await mkdir(join(archive, '3.0.0'), { recursive: true }); // no bundle → missing
    // 4.0.0 present but tampered → refused
    await mkdir(join(archive, '4.0.0', 'linux-x64'), { recursive: true });
    await writeFile(join(archive, '4.0.0', 'linux-x64', 'claude'), 'process.env.PATCHED;');
    await writeFile(
      join(archive, '4.0.0', 'SHA256SUMS'),
      `${sha256('official')}  linux-x64/claude\n`
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['--archive', archive, '--out', out]);

    expect(code).toBe(0);
    const c1 = JSON.parse(await readFile(join(out, '1.0.0.json'), 'utf-8')) as {
      symbols: { symbol: string }[];
    };
    const c2 = JSON.parse(await readFile(join(out, '2.0.0.json'), 'utf-8')) as {
      symbols: { symbol: string }[];
    };
    expect(c1.symbols.some((s) => s.symbol === 'CLAUDE_CODE_A')).toBe(true);
    expect(c2.symbols.some((s) => s.symbol === '--foo')).toBe(true);
    // The control lane's output rides in the same file, keyed separately so the
    // two extractions cannot be confused for one another downstream.
    const c2control = JSON.parse(await readFile(join(out, '2.0.0.json'), 'utf-8')) as {
      controlCount: number;
      controlMessages: { symbol: string; family: string }[];
    };
    expect(c2control.controlMessages.map((m) => m.symbol)).toEqual(['initialize']);
    expect(c2control.controlCount).toBe(1);
    expect(c2control.controlMessages[0]?.family).toBe('control_request');
    expect(existsSync(join(out, '3.0.0.json'))).toBe(false);
    expect(existsSync(join(out, '4.0.0.json'))).toBe(false); // refused, not extracted
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('without a readable binary: 3.0.0')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('refused (checksum mismatch or missing SHA256SUMS): 4.0.0')
    );
  });

  it('fails the run and writes nothing for a version whose bundle the control lane refuses', async () => {
    // The whole point of the control lane's refusal is that absence downstream reads
    // as a removal. So a refusal must not be a warning the caller can miss: no cache
    // entry for that version, a non-zero exit, and the version named in the error.
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-refuse-'));
    const archive = join(root, 'archive');
    const out = join(root, 'out');
    await writeCompiled(archive, '1.0.0', 'if(process.env.CLAUDE_CODE_A)x();'); // below the floor
    await writeCompiled(archive, '2.0.0', 'this is not parseable javascript {{{'); // refused
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(['--archive', archive, '--out', out]);

    expect(code).toBe(1);
    expect(existsSync(join(out, '2.0.0.json'))).toBe(false);
    expect(existsSync(join(out, '1.0.0.json'))).toBe(true); // unaffected versions still written
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('must not be backfilled from'));
    errSpy.mockRestore();
  });

  it('clears every prior cache file backfill would read (non-underscore *.json), keeping _-prefixed', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-prune-'));
    const archive = join(root, 'archive');
    const out = join(root, 'out');
    await writeCompiled(archive, '1.0.0', 'process.env.CLAUDE_CODE_C;');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, '9.9.9.json'), '{"stale":1}'); // old version, gone from archive
    await writeFile(join(out, '_verify-report.json'), '{"ok":1}'); // sidecar, keep
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['--archive', archive, '--out', out]);

    expect(existsSync(join(out, '9.9.9.json'))).toBe(false);
    expect(existsSync(join(out, '_verify-report.json'))).toBe(true);
    expect(existsSync(join(out, '1.0.0.json'))).toBe(true);
  });

  it('refuses to regenerate a cache in a directory holding non-cache files', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-safeout-'));
    const archive = join(root, 'archive');
    const out = join(root, 'out');
    await writeCompiled(archive, '1.0.0', 'process.env.X;');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'latest.json'), '{"important":1}'); // e.g. a mistyped --out data
    await expect(main(['--archive', archive, '--out', out])).rejects.toThrow(
      /Refusing to regenerate/
    );
    expect(existsSync(join(out, 'latest.json'))).toBe(true); // untouched
  });

  it('extracts a verified npm bundle.tgz even when the archive path contains a space', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-tar-'));
    const archive = join(root, 'has space', 'archive');
    const out = join(root, 'out');
    const pkg = join(root, 'pkg');
    await mkdir(join(pkg, 'package'), { recursive: true });
    await writeFile(join(pkg, 'package', 'cli.js'), 'process.env.CLAUDE_CODE_TGZ;');
    await mkdir(join(archive, '1.0.0'), { recursive: true });
    const tgz = join(archive, '1.0.0', 'bundle.tgz');
    execFileSync('tar', ['czf', tgz, '-C', pkg, 'package/cli.js']);
    const hash = createHash('sha256')
      .update(await readFile(tgz))
      .digest('hex');
    await writeFile(join(archive, '1.0.0', 'SHA256SUMS'), `${hash}  bundle.tgz\n`);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['--archive', archive, '--out', out]);

    const c = JSON.parse(await readFile(join(out, '1.0.0.json'), 'utf-8')) as {
      symbols: { symbol: string }[];
    };
    expect(c.symbols.some((s) => s.symbol === 'CLAUDE_CODE_TGZ')).toBe(true);
  });

  it('throws actionable guidance when the archive holds no versions', async () => {
    root = await mkdtemp(join(tmpdir(), 'claustodian-reextract-empty-'));
    const archive = join(root, 'archive');
    await mkdir(archive, { recursive: true });
    await expect(main(['--archive', archive, '--out', join(root, 'out')])).rejects.toThrow(
      /No archived versions/
    );
  });
});
