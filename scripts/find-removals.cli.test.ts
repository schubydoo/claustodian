// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from './find-removals.js';

const CHANGELOG = `# Changelog

## 2.1.92

- Removed \`/vim\` command
- Removed \`/legacy-cmd\`

## 2.1.90

- Removed the startup warning — run \`/doctor\` to see it instead
`;

// /legacy-cmd is a known symbol not in any confirmed list; /vim is a confirmed
// removal; /doctor is only referenced (a false positive).
const DATASET = JSON.stringify({
  symbols: [
    { type: 'command', symbol: '/legacy-cmd' },
    { type: 'command', symbol: '/doctor' },
    { type: 'command', symbol: '/vim' },
  ],
});

describe('find-removals main()', () => {
  let tmpDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    logSpy?.mockRestore();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('reports known, unconfirmed candidates and skips false positives + confirmed ones', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-removals-'));
    const clPath = join(tmpDir, 'CHANGELOG.md');
    const dsPath = join(tmpDir, 'latest.json');
    await writeFile(clPath, CHANGELOG, 'utf-8');
    await writeFile(dsPath, DATASET, 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['--changelog', clPath, '--dataset', dsPath]);
    expect(code).toBe(0);

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // /legacy-cmd is a known, unconfirmed retirement → reported.
    expect(output).toContain('/legacy-cmd');
    // /vim is confirmed in CONFIRMED_REMOVALS → not re-proposed.
    expect(output).not.toContain('/vim');
    // /doctor is only referenced, never the object of "Removed" → never proposed.
    expect(output).not.toContain('/doctor');
  });

  it('says nothing to review when no candidate is both known and unconfirmed', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-removals-'));
    const clPath = join(tmpDir, 'CHANGELOG.md');
    const dsPath = join(tmpDir, 'latest.json');
    // Only /vim (already confirmed) appears as a retirement.
    await writeFile(clPath, '# Changelog\n\n## 2.1.92\n\n- Removed `/vim` command\n', 'utf-8');
    await writeFile(dsPath, JSON.stringify({ symbols: [{ type: 'command', symbol: '/vim' }] }), 'utf-8');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['--changelog', clPath, '--dataset', dsPath]);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('up to date');
  });

  it('throws on a flag passed without a value (no silent fallback)', async () => {
    await expect(main(['--dataset'])).rejects.toThrow(/--dataset requires a path/);
    await expect(main(['--changelog'])).rejects.toThrow(/--changelog requires a path/);
  });

  it('throws on an unknown/mistyped argument instead of scanning defaults', async () => {
    await expect(main(['--changlog', 'x'])).rejects.toThrow(/Unknown argument "--changlog"/);
  });

  it('proposes a known Deprecated candidate but skips a confirmed one', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-removals-'));
    const clPath = join(tmpDir, 'CHANGELOG.md');
    const dsPath = join(tmpDir, 'latest.json');
    // /new-dep is known + unconfirmed → proposed; /output-style is a confirmed
    // deprecation → skipped. Exercises the Deprecated branch of the verb filter.
    await writeFile(
      clPath,
      '# Changelog\n\n## 2.1.99\n\n- Deprecated `/new-dep`\n- Deprecated `/output-style`\n',
      'utf-8'
    );
    await writeFile(
      dsPath,
      JSON.stringify({
        symbols: [
          { type: 'command', symbol: '/new-dep' },
          { type: 'command', symbol: '/output-style' },
        ],
      }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['--changelog', clPath, '--dataset', dsPath]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('/new-dep');
    expect(output).not.toContain('/output-style');
  });

  it('still surfaces a Removed bullet for an already-deprecated symbol', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claustodian-removals-'));
    const clPath = join(tmpDir, 'CHANGELOG.md');
    const dsPath = join(tmpDir, 'latest.json');
    // /output-style is in CONFIRMED_DEPRECATIONS; a later Removed bullet must not
    // be masked by the deprecation confirmation.
    await writeFile(clPath, '# Changelog\n\n## 2.1.99\n\n- Removed `/output-style`\n', 'utf-8');
    await writeFile(
      dsPath,
      JSON.stringify({ symbols: [{ type: 'command', symbol: '/output-style' }] }),
      'utf-8'
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await main(['--changelog', clPath, '--dataset', dsPath]);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
      '/output-style'
    );
  });
});
