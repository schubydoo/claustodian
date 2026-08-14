// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareVersionsAsc, isMain, loadChangelog, runCli } from './lib.js';

describe('isMain', () => {
  it('is true when the given URL matches the process entry point', () => {
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', '/some/fake/path/script.js'];
    try {
      expect(isMain(pathToFileURL('/some/fake/path/script.js').href)).toBe(true);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('is false when the given URL does not match the process entry point', () => {
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', '/some/fake/path/script.js'];
    try {
      expect(isMain(pathToFileURL('/some/other/path.js').href)).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('is false when process.argv[1] is undefined', () => {
    const originalArgv = [...process.argv];
    process.argv = [originalArgv[0] ?? 'node'];
    try {
      expect(isMain('file:///anything')).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe('runCli', () => {
  // The URL isMain treats as "invoked directly" under the test runner.
  const entrypointUrl = pathToFileURL(process.argv[1] ?? '').href;

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

  it('does not run main when the module is merely imported', () => {
    const run = vi.fn(async () => 0);
    runCli(`${entrypointUrl}.not-the-entrypoint`, 'testing', run);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs main with the CLI argv and records its exit code when the module is the entrypoint', async () => {
    const run = vi.fn(async () => 3);
    runCli(entrypointUrl, 'testing', run);
    await flushMicrotasks();
    expect(run).toHaveBeenCalledWith(process.argv.slice(2));
    expect(process.exitCode).toBe(3);
  });

  it('treats a void resolution as success', async () => {
    process.exitCode = 7;
    runCli(entrypointUrl, 'testing', async () => undefined);
    await flushMicrotasks();
    expect(process.exitCode).toBe(0);
  });

  it('reports a rejection under the label and exits 1', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runCli(entrypointUrl, 'doing the thing', async () => {
      throw new Error('boom');
    });
    await flushMicrotasks();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Unexpected error while doing the thing:',
      expect.objectContaining({ message: 'boom' })
    );
  });
});

describe('compareVersionsAsc', () => {
  it('treats a missing segment as zero, so a short version compares numerically', () => {
    // Every current caller feeds the comparator full X.Y.Z strings, but it is
    // an exported helper with no input contract; a short string must not sort
    // as text or crash it.
    expect(compareVersionsAsc('2', '2.0.0')).toBe(0);
    expect(compareVersionsAsc('2.1', '2.1.1')).toBeLessThan(0);
    expect(compareVersionsAsc('2.1.1', '2.1')).toBeGreaterThan(0);
  });
});

describe('loadChangelog', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('reads from a local file when changelogPath is given', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-lib-'));
    const filePath = join(tmpDir, 'CHANGELOG.md');
    await writeFile(filePath, '# Changelog\n\n## 1.0.0\n\n- Added `--foo` flag.\n', 'utf-8');

    const content = await loadChangelog(filePath);
    expect(content).toContain('--foo');
  });

  it('fetches from CHANGELOG_URL when no changelogPath is given, and returns the body on ok', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('# Changelog\n\n## 1.0.0\n\n- Added `--bar` flag.\n'),
    });
    vi.stubGlobal('fetch', fakeFetch);

    const content = await loadChangelog(undefined);
    expect(content).toContain('--bar');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error when the fetch response is not ok', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fakeFetch);

    await expect(loadChangelog(undefined)).rejects.toThrow(/404/);
  });
});
