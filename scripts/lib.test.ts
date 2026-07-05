// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isMain, loadChangelog } from './lib.js';

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
