// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './backfill-docs-history.js';

describe('backfill-docs-history (a throwaway git repo)', () => {
  let dir: string;
  let prev: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  const commit = async (latest: string, observed: string[] | null, text: string) => {
    const docs = { symbols: [{ type: 'env_var', symbol: 'A', description: text }] };
    await writeFile(join(dir, 'data', 'docs.json'), JSON.stringify(docs), 'utf-8');
    await writeFile(join(dir, 'data', 'index.json'), JSON.stringify({ latest }), 'utf-8');
    if (observed) {
      await writeFile(
        join(dir, 'data', 'binary-observations.json'),
        JSON.stringify({ observedVersions: observed }),
        'utf-8'
      );
    }
    git('add', '-A');
    git('commit', '-qm', latest);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-seed-'));
    await mkdir(join(dir, 'data'));
    git('init', '-q');
    prev = process.cwd();
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  });

  it('replays each committed capture, dated by the newest release then known', async () => {
    // The first capture predates the binary lane's file, as on main.
    await commit('2.1.1', null, 'one');
    await commit('2.1.2', ['2.1.3', '2.1.1'], 'two');
    await main([]);
    const history = JSON.parse(await readFile(join(dir, 'data', 'docs-history.json'), 'utf8'));
    expect(history.descriptions['env_var:A']).toEqual([
      { from: '2.1.1', description: 'one' },
      { from: '2.1.3', description: 'two' },
    ]);
  });

  it('refuses a history with no capture', async () => {
    await writeFile(join(dir, 'README'), 'x', 'utf-8');
    git('add', '-A');
    git('commit', '-qm', 'x');
    await expect(main(['HEAD', join(dir, 'out.json')])).rejects.toThrow(
      /No data\/docs.json capture/
    );
  });
});
