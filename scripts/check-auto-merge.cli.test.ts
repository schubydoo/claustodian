// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './check-auto-merge.js';

const FOO = { type: 'cli_flag', symbol: '--foo', first_seen: '2.1.100', provenance: 'binary' };
const BAR = { type: 'cli_flag', symbol: '--bar', first_seen: '2.1.101', provenance: 'binary' };

function snapshot(symbols: unknown[]): string {
  return JSON.stringify({ claudeCodeVersion: '2.1.200', schemaVersion: 1, symbols });
}

describe('check-auto-merge main()', () => {
  let tmpDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const savedOutput = process.env.GITHUB_OUTPUT;

  afterEach(async () => {
    logSpy?.mockRestore();
    errSpy?.mockRestore();
    if (savedOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = savedOutput;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function writeSnapshots(base: unknown[], next: unknown[]): Promise<[string, string]> {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-automerge-'));
    const basePath = join(tmpDir, 'base.json');
    const nextPath = join(tmpDir, 'next.json');
    await writeFile(basePath, snapshot(base), 'utf-8');
    await writeFile(nextPath, snapshot(next), 'utf-8');
    return [basePath, nextPath];
  }

  it('returns 1 and prints usage when an argument is missing', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main([])).toBe(1);
    expect(await main(['only-one'])).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('Usage:');
  });

  it('clears a clean incremental add and writes auto_merge=true to GITHUB_OUTPUT', async () => {
    const [basePath, nextPath] = await writeSnapshots([FOO], [FOO, BAR]);
    const outPath = join(tmpDir as string, 'gh-output');
    await writeFile(outPath, '', 'utf-8');
    process.env.GITHUB_OUTPUT = outPath;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main([basePath, nextPath])).toBe(0);
    expect(await readFile(outPath, 'utf-8')).toContain('auto_merge=true');
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('SAFE');
  });

  it('withholds a removal and writes auto_merge=false, still exiting 0', async () => {
    const [basePath, nextPath] = await writeSnapshots([FOO, BAR], [FOO]);
    const outPath = join(tmpDir as string, 'gh-output');
    await writeFile(outPath, '', 'utf-8');
    process.env.GITHUB_OUTPUT = outPath;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main([basePath, nextPath])).toBe(0);
    expect(await readFile(outPath, 'utf-8')).toContain('auto_merge=false');
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('WITHHELD');
    expect(out).toContain('::notice::');
  });

  it('does not touch GITHUB_OUTPUT when the env var is unset', async () => {
    const [basePath, nextPath] = await writeSnapshots([FOO], [FOO, BAR]);
    delete process.env.GITHUB_OUTPUT;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await main([basePath, nextPath])).toBe(0);
  });

  it('throws on a file that is not a snapshot (no "symbols" array)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-automerge-'));
    const bad = join(tmpDir, 'bad.json');
    const good = join(tmpDir, 'good.json');
    await writeFile(bad, JSON.stringify({ notSymbols: [] }), 'utf-8');
    await writeFile(good, snapshot([FOO]), 'utf-8');

    await expect(main([bad, good])).rejects.toThrow(/does not look like a snapshot file/);
  });
});
