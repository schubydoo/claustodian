// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertDocsCoverage,
  assertOfficialDocs,
  buildDocsIndex,
  knownSettingsKeys,
  main,
  officialSourcePages,
  PAGE_BASELINE_MIN_VERSION,
  PAGE_MIN_SYMBOLS,
  parseDocPage,
  splitTableRow,
  symbolFromCell,
  symbolsFromCell,
} from './fetch-docs.js';

/**
 * A synthetic page body that clears the page's yield floor, so `main` reaches the
 * write instead of tripping `assertDocsCoverage`. Symbol names are page-unique:
 * an index-wide duplicate would be deduped away and starve the second page.
 */
function mockPageBody(url: string): string {
  const page = (url.split('/').pop() ?? '').replace(/\.md$/, '');
  const floor = PAGE_MIN_SYMBOLS[page as keyof typeof PAGE_MIN_SYMBOLS] ?? 0;
  const rows = Array.from({ length: floor }, (_, i) => i);
  if (page === 'settings-reference') {
    return ['## Tools', ...rows.map((i) => `### \`mockKey${i}\`\n\nA mocked settings key.`)].join(
      '\n\n'
    );
  }
  const cell = (i: number): string => {
    if (page === 'commands') return `/mock-${i}`;
    if (page === 'env-vars') return `MOCK_ENV_${i}`;
    return `--${page}-mock-${i}`;
  };
  return rows.map((i) => `| \`${cell(i)}\` | A mocked symbol |`).join('\n');
}

describe('symbolFromCell', () => {
  it('recognizes a CLI flag', () => {
    expect(symbolFromCell('`--continue`')).toEqual({ symbol: '--continue', type: 'cli_flag' });
  });

  it('recognizes a slash command, stripping its argument', () => {
    expect(symbolFromCell('`/add-dir <path>`')).toEqual({ symbol: '/add-dir', type: 'command' });
  });

  it('recognizes an environment variable', () => {
    expect(symbolFromCell('`ANTHROPIC_API_KEY`')).toEqual({
      symbol: 'ANTHROPIC_API_KEY',
      type: 'env_var',
    });
  });

  it('prefers a flag over an env-looking token in the same cell', () => {
    expect(symbolFromCell('`--model` overrides `ANTHROPIC_MODEL`')).toEqual({
      symbol: '--model',
      type: 'cli_flag',
    });
  });

  it('skips generic OS env vars (denylist)', () => {
    expect(symbolFromCell('`PATH`')).toBeNull();
  });

  it('skips the SKILL concept-label false positive (denylist)', () => {
    expect(symbolFromCell('`SKILL`')).toBeNull();
  });

  it('returns null for a `claude subcommand` row and for prose', () => {
    expect(symbolFromCell('`claude auth login`')).toBeNull();
    expect(symbolFromCell('Start interactive session')).toBeNull();
  });

  it('does NOT treat an embedded slash in a path/capability as a command', () => {
    // the /channel, /foo, /src, /secrets fakes: a leading segment precedes the `/`,
    // so these are prose about channels/plugins/tools, not slash commands.
    expect(symbolFromCell('`claude/channel`')).toBeNull();
    expect(symbolFromCell('`commands/foo`')).toBeNull();
    expect(symbolFromCell('`tools/src`')).toBeNull();
    expect(symbolFromCell('`.claude/settings.json`')).toBeNull();
  });

  it('takes the slash command, not its bracketed arguments, as the subject', () => {
    // commands.md writes a command's arguments inside the same backtick span.
    // Scanning for a flag first took the argument as the row's subject: it lost
    // the command AND published the argument as a top-level CLI flag carrying
    // the command's description.
    expect(symbolFromCell('`/reload-plugins [--force]`')).toEqual({
      symbol: '/reload-plugins',
      type: 'command',
    });
    expect(
      symbolFromCell('`/code-review [low\\|medium\\|high] [--fix] [--comment] [pr#\\|branch]`')
    ).toEqual({ symbol: '/code-review', type: 'command' });
    expect(symbolFromCell('`/import [codex\\|gemini] [--dry-run] [--yes]`')).toEqual({
      symbol: '/import',
      type: 'command',
    });
  });

  it('still reads a genuine flag whose cell is not a slash command', () => {
    // The command anchor only fires on a cell that STARTS with `/…`, so a real
    // flag row is untouched by the reordering.
    expect(symbolFromCell('`--force`')).toEqual({ symbol: '--force', type: 'cli_flag' });
    expect(symbolFromCell('`--dry-run <path>`')).toEqual({ symbol: '--dry-run', type: 'cli_flag' });
  });

  it('still recognizes a leading slash command with surrounding text', () => {
    expect(symbolFromCell('`/compact` clears history')).toEqual({
      symbol: '/compact',
      type: 'command',
    });
  });
});

describe('symbolsFromCell', () => {
  it('emits both flags of a slash-joined same-type pair', () => {
    expect(symbolsFromCell('`--sandbox` / `--no-sandbox`')).toEqual([
      { symbol: '--sandbox', type: 'cli_flag' },
      { symbol: '--no-sandbox', type: 'cli_flag' },
    ]);
  });

  it('emits both flags of a comma-joined alias pair', () => {
    expect(symbolsFromCell('`--remote-control`, `--rc`')).toEqual([
      { symbol: '--remote-control', type: 'cli_flag' },
      { symbol: '--rc', type: 'cli_flag' },
    ]);
  });

  it('skips a camelCase alias and keeps the in-grammar one', () => {
    // The real cli-reference.md cell. `--allowedTools` is out of the lane's grammar;
    // truncating it at the capital `T` produced the phantom `--allowed`, published
    // since 0.2.33 with the real flag's description. Rejecting it must not take the
    // valid alias down with it.
    expect(symbolsFromCell('`--allowedTools`, `--allowed-tools`')).toEqual([
      { symbol: '--allowed-tools', type: 'cli_flag' },
    ]);
    expect(symbolsFromCell('`--disallowedTools`, `--disallowed-tools`')).toEqual([
      { symbol: '--disallowed-tools', type: 'cli_flag' },
    ]);
  });

  it('names no symbol at all for a cell that is only an out-of-grammar flag', () => {
    expect(symbolsFromCell('`--allowedTools`')).toEqual([]);
  });

  it('returns only the primary symbol when prose separates the spans', () => {
    // A flag whose description names an env var it overrides is NOT a pair.
    expect(symbolsFromCell('`--model` overrides `ANTHROPIC_MODEL`')).toEqual([
      { symbol: '--model', type: 'cli_flag' },
    ]);
  });

  it('does not pair spans of different types even when separator-joined', () => {
    expect(symbolsFromCell('`--model`, `ANTHROPIC_MODEL`')).toEqual([
      { symbol: '--model', type: 'cli_flag' },
    ]);
  });

  it('returns a single-element list for an ordinary one-symbol cell', () => {
    expect(symbolsFromCell('`--continue`')).toEqual([{ symbol: '--continue', type: 'cli_flag' }]);
  });

  it('returns an empty list when the first span names no trackable symbol', () => {
    expect(symbolsFromCell('`claude auth login`')).toEqual([]);
  });
});

describe('parseDocPage', () => {
  const md = [
    '# CLI flags',
    '',
    '| Flag | Description |',
    '| :--- | :--- |',
    '| `--continue` | Load the most recent conversation in the current directory |',
    '| `--advisor` | {/* min-version: 2.1.98 */}Enable the advisor tool. Requires Claude Code v2.1.98 or later |',
    '| `claude gateway` | Start the gateway. Available in Claude Code v2.1.195 and later |',
    '| not-a-row | just prose |',
  ].join('\n');

  it('extracts symbol + description from table rows, skipping separators and prose', () => {
    const entries = parseDocPage('cli-reference', md);
    const flags = entries.filter((e) => e.type === 'cli_flag');
    expect(flags.map((e) => e.symbol)).toEqual(['--continue', '--advisor']);
  });

  it('skips a table row with a single cell', () => {
    const entries = parseDocPage(
      'cli-reference',
      '| `--lonely` |\n| `--kept` | A flag with a real description |'
    );
    expect(entries.map((e) => e.symbol)).toEqual(['--kept']);
  });

  it('captures a min-version and strips MDX comments from the description', () => {
    const advisor = parseDocPage('cli-reference', md).find((e) => e.symbol === '--advisor');
    expect(advisor?.doc_min_version).toBe('2.1.98');
    expect(advisor?.description).toBe(
      'Enable the advisor tool. Requires Claude Code v2.1.98 or later'
    );
    expect(advisor?.description).not.toContain('min-version');
  });

  it('strips markdown links to their text', () => {
    const md2 = '| `--xray` | See [the docs](/en/foo) for details |';
    const entry = parseDocPage('p', md2)[0];
    expect(entry?.description).toBe('See the docs for details');
  });

  it('unescapes markdown backslash escapes so the literal backslash never surfaces', () => {
    const entry = parseDocPage(
      'env-vars',
      '| `ANTHROPIC_SMALL_FAST_MODEL` | \\[DEPRECATED] a\\_b |'
    )[0];
    expect(entry?.description).toBe('[DEPRECATED] a_b');
  });

  it('keeps a backslash literal inside an inline code span (not treated as an escape)', () => {
    const entry = parseDocPage('env-vars', '| `--xray` | uses `foo\\_bar` as a key |')[0];
    expect(entry?.description).toBe('uses `foo\\_bar` as a key');
  });

  it('emits every flag of an unmarked pair cell dateless (baseline is applied later)', () => {
    // parseDocPage never applies the page baseline itself — that happens in
    // buildDocsIndex after dedupe, so it can't ride the cross-page backfill.
    const entry = parseDocPage(
      'remote-control',
      '| `--sandbox` / `--no-sandbox` | Enable or disable sandboxing. |'
    );
    expect(entry.map((e) => e.symbol)).toEqual(['--sandbox', '--no-sandbox']);
    expect(entry.every((e) => e.doc_min_version === null)).toBe(true);
    expect(entry[0]?.description).toBe('Enable or disable sandboxing.');
  });

  it('captures a cell-level min-version even on a baselined page', () => {
    const entry = parseDocPage(
      'remote-control',
      '| `--session-id <id>` | {/* min-version: 2.1.200 */}Resume a session by id. |'
    )[0];
    expect(entry?.doc_min_version).toBe('2.1.200');
  });

  it('leaves an unmarked flag dateless on a page with no baseline', () => {
    const entry = parseDocPage('cli-reference', '| `--xray` | Some flag. |')[0];
    expect(entry?.doc_min_version).toBeNull();
  });

  it('skips a row whose description is too short (< 3 chars)', () => {
    expect(parseDocPage('cli-reference', '| `--tiny` | ab |')).toEqual([]);
  });

  it('reads a min-version from the first cell when the description cell has none', () => {
    // Exercises the `?? minVersion(cells[0])` fallback: marker in the symbol cell.
    const entry = parseDocPage(
      'cli-reference',
      '| `--xray` {/* min-version: 2.1.10 */} | plain description, no version |'
    )[0];
    expect(entry?.doc_min_version).toBe('2.1.10');
  });

  it('does not resurrect a deliberately-escaped link into active markdown', () => {
    const entry = parseDocPage('env-vars', '| `--xray` | see \\[text\\]\\(url\\) here |')[0];
    expect(entry?.description).toBe('see text here');
  });
});

describe('PAGE_BASELINE_MIN_VERSION', () => {
  it('baselines the remote-control page at the feature introduction version', () => {
    expect(PAGE_BASELINE_MIN_VERSION['remote-control']).toBe('2.1.51');
  });
});

describe('buildDocsIndex', () => {
  it('dedupes by type:symbol (first page wins) and sorts by type then symbol', () => {
    const pages = [
      { page: 'cli-reference', markdown: '| `--zebra` | first def |\n| `--alpha` | alpha flag |' },
      {
        page: 'commands',
        markdown: '| `--zebra` | second def (ignored) |\n| `/cmd` | the command |',
      },
    ];
    const index = buildDocsIndex(pages);
    expect(index.symbols.map((s) => `${s.type}:${s.symbol}`)).toEqual([
      'cli_flag:--alpha',
      'cli_flag:--zebra',
      'command:/cmd',
    ]);
    const zebra = index.symbols.find((s) => s.symbol === '--zebra');
    expect(zebra?.description).toBe('first def');
    expect(zebra?.doc_page).toBe('cli-reference');
  });

  it('backfills a missing min-version from a later page', () => {
    const pages = [
      { page: 'cli-reference', markdown: '| `--xray` | no version here |' },
      { page: 'commands', markdown: '| `--xray` | {/* min-version: 2.1.50 */}later mention |' },
    ];
    const index = buildDocsIndex(pages);
    expect(index.symbols[0]?.doc_min_version).toBe('2.1.50');
    expect(index.symbols[0]?.description).toBe('no version here');
  });

  it('applies a page baseline to a symbol the baselined page owns', () => {
    const index = buildDocsIndex([
      { page: 'remote-control', markdown: '| `--sandbox` | Toggle sandboxing. |' },
    ]);
    expect(index.symbols.find((s) => s.symbol === '--sandbox')?.doc_min_version).toBe('2.1.51');
  });

  it('does NOT let a baseline cross onto an earlier page’s dateless flag', () => {
    // The Greptile regression: `--verbose` wins from cli-reference (dateless) and
    // also appears dateless under remote-control (2.1.51 baseline). It must stay
    // dateless — the baseline belongs to remote-control's own symbols only.
    const index = buildDocsIndex([
      { page: 'cli-reference', markdown: '| `--verbose` | Global verbose flag. |' },
      { page: 'remote-control', markdown: '| `--verbose` | Show detailed logs. |' },
    ]);
    const verbose = index.symbols.find((s) => s.symbol === '--verbose');
    expect(verbose?.doc_page).toBe('cli-reference');
    expect(verbose?.doc_min_version).toBeNull();
  });

  it('does NOT backfill a supplemental page’s cell min-version onto an earlier flag', () => {
    // remote-control's `--session-id` @2.1.200 is a different flag from the
    // top-level `--session-id` (@1.0.53); it must not stamp 2.1.200 on the older one.
    const index = buildDocsIndex([
      { page: 'cli-reference', markdown: '| `--session-id` | Use a specific session ID. |' },
      {
        page: 'remote-control',
        markdown: '| `--session-id` | {/* min-version: 2.1.200 */}Resume a session by id. |',
      },
    ]);
    const sid = index.symbols.find((s) => s.symbol === '--session-id');
    expect(sid?.doc_page).toBe('cli-reference');
    expect(sid?.doc_min_version).toBeNull();
  });
});

describe('main (mocked fetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the pages and writes a docs index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({ ok: true, text: async () => mockPageBody(url) }))
    );
    const out = '/tmp/claustodian-fetch-docs.test.json';
    await main([out]);
    const index = JSON.parse(await readFile(out, 'utf8'));
    expect(
      index.symbols.some((s: { symbol: string }) => s.symbol === '--cli-reference-mock-0')
    ).toBe(true);
    await rm(out, { force: true });
  });

  it('refuses to write when a page stops yielding symbols', async () => {
    // The settings-page regression: the page still fetched and still parsed, but
    // its tables had moved, so it yielded nothing and every documented settings
    // key silently lost its description.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        text: async () => (url.endsWith('/settings-reference.md') ? '' : mockPageBody(url)),
      }))
    );
    await expect(main(['/tmp/claustodian-fetch-docs.floor.json'])).rejects.toThrow(
      /"settings-reference" yielded 0 of the/
    );
  });

  it('defaults both paths when called with no argv', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({ ok: true, text: async () => mockPageBody(url) }))
    );
    const dir = await mkdtemp(join(tmpdir(), 'claustodian-docs-main-'));
    await mkdir(join(dir, 'data'));
    await writeFile(
      join(dir, 'data', 'binary-observations.json'),
      JSON.stringify({ symbols: [{ type: 'config_key', symbol: 'advisorModel' }] }),
      'utf-8'
    );
    const prev = process.cwd();
    process.chdir(dir);
    try {
      await main([]);
      const index = JSON.parse(await readFile(join(dir, 'data', 'docs.json'), 'utf8'));
      expect(
        index.symbols.some((s: { symbol: string }) => s.symbol === '--cli-reference-mock-0')
      ).toBe(true);
    } finally {
      process.chdir(prev);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }))
    );
    await expect(main(['/tmp/claustodian-fetch-docs.err.json'])).rejects.toThrow(/Failed to fetch/);
  });
});

describe('splitTableRow', () => {
  const cells = (line: string) =>
    splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());

  it('splits on real column delimiters', () => {
    expect(cells('| a | b | c |')).toEqual(['a', 'b', 'c']);
  });

  it('does not split on an escaped pipe, and unescapes it', () => {
    expect(cells('| a | b \\| c |')).toEqual(['a', 'b | c']);
  });

  it('does not split on a pipe inside an inline-code span', () => {
    expect(cells('| a | uses `model|fallback` here |')).toEqual([
      'a',
      'uses `model|fallback` here',
    ]);
  });
});

describe('parseDocPage — pipe handling', () => {
  it('keeps a description containing escaped pipes intact (not truncated)', () => {
    const entries = parseDocPage('cli-reference', '| `--fmt` | outputs a \\| b \\| c |');
    expect(entries[0]?.description).toBe('outputs a | b | c');
  });

  it('handles an escaped pipe inside the symbol cell', () => {
    const entries = parseDocPage(
      'commands',
      '| `/advisor [model\\|off]` | Enable the advisor tool |'
    );
    expect(entries[0]).toMatchObject({
      symbol: '/advisor',
      description: 'Enable the advisor tool',
    });
  });

  it('keeps a description with an UNescaped pipe inside inline code intact', () => {
    const entries = parseDocPage('cli-reference', '| `--model` | pick `sonnet|opus|fable` model |');
    expect(entries[0]).toMatchObject({
      symbol: '--model',
      description: 'pick `sonnet|opus|fable` model',
    });
  });
});

describe('assertOfficialDocs', () => {
  const official = officialSourcePages();
  const entry = (doc_page: string) => ({
    symbol: '--x',
    type: 'cli_flag' as const,
    description: 'x',
    doc_min_version: null,
    doc_page,
  });

  it('accepts an index with official source_pages and doc_pages', () => {
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: official,
        symbols: [entry('cli-reference')],
      })
    ).not.toThrow();
  });

  it('rejects an index whose source_pages are not the official docs URLs', () => {
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: ['https://evil.example/docs.md'],
        symbols: [],
      })
    ).toThrow(/source_pages/);
  });

  it('rejects an entry referencing a non-official doc_page', () => {
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: official,
        symbols: [entry('not-a-real-page')],
      })
    ).toThrow(/non-official doc_page/);
  });
});

describe('parseDocPage — settings page', () => {
  const known = new Set([
    'advisorModel',
    'permissions.allow',
    'sandbox.filesystem.allowWrite',
    'skipDangerousModePermissionPrompt',
    'policyHelper.path',
    'worktree.baseRef',
  ]);
  const page = (body: string) => parseDocPage('settings', body, known);

  it('reads a flat key from the definitional table', () => {
    const md =
      '### Available settings\n\n| Key | Description |\n| :-- | :-- |\n| `advisorModel` | Model for the advisor tool |\n';
    expect(page(md)).toEqual([
      {
        symbol: 'advisorModel',
        type: 'config_key',
        description: 'Model for the advisor tool',
        doc_min_version: null,
        doc_page: 'settings',
      },
    ]);
  });

  it('qualifies a bare key with its section namespace', () => {
    const md =
      '### Permission settings\n\n| Keys | Description |\n| :-- | :-- |\n| `allow` | Rules to allow tool use |\n';
    expect(page(md)[0]?.symbol).toBe('permissions.allow');
  });

  it('keeps a sub-namespace rooted at the section, not treated as already qualified', () => {
    // Sandbox rows use sub-namespaces. Testing "contains a dot" instead of
    // "already rooted here" strands 23 keys as bare `filesystem.*`.
    const md =
      '### Sandbox settings\n\n| Keys | Description |\n| :-- | :-- |\n| `filesystem.allowWrite` | Extra writable paths |\n';
    expect(page(md)[0]?.symbol).toBe('sandbox.filesystem.allowWrite');
  });

  it('falls back to the top-level path for a topic-grouped row', () => {
    // The page groups by topic, not JSON nesting: this key sits under "Permission
    // settings" while the schema has it flat. Prefixing blindly would publish
    // `permissions.skipDangerousModePermissionPrompt`, which does not exist.
    const md =
      '### Permission settings\n\n| Keys | Description |\n| :-- | :-- |\n| `skipDangerousModePermissionPrompt` | Skip the confirmation prompt |\n';
    expect(page(md)[0]?.symbol).toBe('skipDangerousModePermissionPrompt');
  });

  it('throws when a namespaced row matches no real path', () => {
    const md =
      '### Permission settings\n\n| Keys | Description |\n| :-- | :-- |\n| `inventedKey` | Something new |\n';
    expect(() => page(md)).toThrow(/matches neither/);
  });

  it('refuses to resolve a namespaced section with no schema supplied', () => {
    const md =
      '### Permission settings\n\n| Keys | Description |\n| :-- | :-- |\n| `allow` | Rules |\n';
    expect(() => parseDocPage('settings', md)).toThrow(/Refusing to guess a key path/);
  });

  it('skips a settings row with a single cell', () => {
    const md =
      '### Available settings\n\n| Key | Description |\n| :-- | :-- |\n' +
      '| `advisorModel` |\n' +
      '| `permissions.allow` | Rules to allow tool use |\n';
    expect(page(md).map((e) => e.symbol)).toEqual(['permissions.allow']);
  });

  it('skips a settings row whose description is too short to be one', () => {
    const md =
      '### Available settings\n\n| Key | Description |\n| :-- | :-- |\n| `advisorModel` | ok |\n';
    expect(page(md)).toEqual([]);
  });

  it('falls back to column 1 when a row is shorter than the header description column', () => {
    // The header promises a Description in column 2, but this row only has two
    // cells; the parser must read the second cell rather than drop the row.
    const md =
      '### Available settings\n\n| Key | Type | Description |\n| :-- | :-- | :-- |\n' +
      '| `advisorModel` | Model for the advisor tool |\n';
    expect(page(md)[0]).toMatchObject({
      symbol: 'advisorModel',
      description: 'Model for the advisor tool',
    });
  });

  it('reads the description column from the header, not by position', () => {
    // The policy-helper table is `| Key | Type | Description |`; taking column 1
    // published "string" as the description.
    const md =
      '### Compute managed settings with a policy helper\n\n| Key | Type | Description |\n| :-- | :-- | :-- |\n' +
      '| `path` | string | Absolute path to the helper executable |\n';
    expect(page(md)[0]).toMatchObject({
      symbol: 'policyHelper.path',
      description: 'Absolute path to the helper executable',
    });
  });

  it('ignores sections that do not define settings keys', () => {
    // "Permission rule syntax" lists rules (`Bash`), not keys; a behaviour table
    // describes error handling rather than what a key does.
    const md =
      '### Permission rule syntax\n\n| Rule | Effect |\n| :-- | :-- |\n| `Bash` | Matches all Bash commands |\n' +
      '### Plugin settings\n\n| Component | Description |\n| :-- | :-- |\n| `skills` | Plugin skills |\n';
    expect(page(md)).toEqual([]);
  });

  it('tags a global-config key with its own category', () => {
    // These are real config keys, but they live in ~/.claude.json and the page
    // says Claude Code "silently ignores them" in settings.json. Publishing them
    // as ordinary `settings` would assert what the page denies; dropping them
    // would lose documented surface. categorize() cannot tell the difference —
    // the names are indistinguishable, only the reading file differs.
    const md =
      '### Global config settings\n\n| Key | Description |\n| :-- | :-- |\n| `diffTool` | Where to show diffs |\n';
    expect(page(md)).toEqual([
      {
        symbol: 'diffTool',
        type: 'config_key',
        description: 'Where to show diffs',
        doc_min_version: null,
        doc_page: 'settings',
        category: 'global-config',
      },
    ]);
  });

  it('leaves settings.json keys without a category override', () => {
    const md =
      '### Available settings\n\n| Key | Description |\n| :-- | :-- |\n| `advisorModel` | Model for the advisor |\n';
    expect(page(md)[0]).not.toHaveProperty('category');
  });

  it('emits config keys only, never flags or env vars from the same page', () => {
    const md =
      '### Available settings\n\n| Key | Description |\n| :-- | :-- |\n' +
      '| `advisorModel` | Model for the advisor tool |\n' +
      '| `--settings` | A flag mentioned in passing |\n' +
      '| `CLAUDE_CODE_SAFE_MODE` | An env var mentioned in passing |\n';
    expect(page(md).map((e) => e.type)).toEqual(['config_key']);
  });
});

describe('parseDocPage — settings-reference page', () => {
  const page = (body: string) => parseDocPage('settings-reference', body);

  it('reads a key and its opening paragraph from an entry heading', () => {
    const md =
      '## Model and responses\n\n### `advisorModel`\n\nPick which model answers when Claude calls the advisor.\n';
    expect(page(md)).toEqual([
      {
        symbol: 'advisorModel',
        type: 'config_key',
        description: 'Pick which model answers when Claude calls the advisor.',
        doc_min_version: null,
        doc_page: 'settings-reference',
      },
    ]);
  });

  it('takes the full key path from the heading, with no schema supplied', () => {
    // Entry headings are already fully qualified, so unlike the settings page
    // there is no bare key to resolve and nothing to guess.
    const md =
      '## Sandbox settings\n\n### `sandbox.credentials.envVars`\n\nProtect environment variables from sandboxed commands.\n';
    expect(page(md)[0]?.symbol).toBe('sandbox.credentials.envVars');
  });

  it('stops the description at the end of the opening paragraph', () => {
    const md =
      '## Tools\n\n### `spellcheck`\n\nCheck spelling as you type.\n\n* **Scope**: `Any file`\n* **Type**: Boolean\n';
    expect(page(md)[0]?.description).toBe('Check spelling as you type.');
  });

  it('reads a min-version stated in the opening paragraph', () => {
    const md =
      '## Sandbox settings\n\n### `sandbox.credentials`\n\nDeclare the credentials to protect. Requires Claude Code v2.1.187 or later.\n';
    expect(page(md)[0]?.doc_min_version).toBe('2.1.187');
  });

  it('does NOT read a min-version stated later in the entry', () => {
    // An entry documents its key's sub-options, and those carry their own version
    // sentences. `extraKnownMarketplaces` states one for the `skipLfs` field of
    // its source objects; the key itself is many releases older.
    const md =
      '## Plugins and skills\n\n### `extraKnownMarketplaces`\n\nTrust marketplaces without prompting.\n\n' +
      'For `github` sources, set `"skipLfs": true` inside the `source` object. Requires Claude Code v2.1.153 or later.\n';
    expect(page(md)[0]).toMatchObject({
      symbol: 'extraKnownMarketplaces',
      doc_min_version: null,
    });
  });

  it('drops a whole-line component tag so a callout-first entry keeps its text', () => {
    const md =
      '## Git and attribution\n\n### `includeCoAuthoredBy`\n\n<Warning>\n  Deprecated since v2.0.62, when `attribution` replaced it.\n</Warning>\n';
    expect(page(md)[0]?.description).toBe(
      'Deprecated since v2.0.62, when `attribution` replaced it.'
    );
  });

  it('tags a global-config key with its own category', () => {
    const md = '## Global config settings\n\n### `diffTool`\n\nChoose where diffs open.\n';
    expect(page(md)[0]).toMatchObject({ symbol: 'diffTool', category: 'global-config' });
  });

  it('leaves a settings.json key without a category override', () => {
    const md = '## Tools\n\n### `spellcheck`\n\nCheck spelling as you type.\n';
    expect(page(md)[0]).not.toHaveProperty('category');
  });

  it('ignores the index table, which lists every key a second time', () => {
    // "All settings" is the index: every row links to the entry below it, so
    // reading both would parse each key twice.
    const md =
      '## All settings\n\n| Key | Description |\n| :-- | :-- |\n' +
      '| [`advisorModel`](#advisormodel) | Pick which model answers |\n';
    expect(page(md)).toEqual([]);
  });

  it('ignores an ENTRY under a section that does not define keys', () => {
    // The allowlist is what stops a new upstream section from publishing keys, so
    // it has to be tested on an entry heading and not only on a table: a section
    // holding no `###` at all yields nothing whatever the allowlist says.
    const md =
      '## All settings\n\n### `advisorModel`\n\nPick which model answers when Claude calls the advisor.\n';
    expect(page(md)).toEqual([]);
  });

  it('skips a stub entry with no prose under its heading', () => {
    const md =
      '## Tools\n\n### `spellcheck`\n\n### `bashTimeout`\n\nFail a Bash command that runs longer than this.\n';
    expect(page(md).map((e) => e.symbol)).toEqual(['bashTimeout']);
  });

  it('skips a prose subheading inside a key-defining section', () => {
    const md =
      '## Tools\n\n### `spellcheck`\n\nCheck spelling as you type.\n\n### Examples\n\nSome prose.\n';
    expect(page(md).map((e) => e.symbol)).toEqual(['spellcheck']);
  });

  it('throws on a backticked entry heading that is not a settings key path', () => {
    // A silent skip here reads downstream as a key that never existed.
    const md = '## Tools\n\n### `CLAUDE_CODE_SAFE_MODE`\n\nAn env var given its own entry.\n';
    expect(() => page(md)).toThrow(/refusing to guess/);
  });

  it('closes the last entry at end of input', () => {
    const md = '## Tools\n\n### `spellcheck`\n\nCheck spelling as you type.';
    expect(page(md)).toHaveLength(1);
  });
});

describe('assertDocsCoverage', () => {
  const index = (counts: Record<string, number>) => ({
    $generated_by: 'scripts/fetch-docs.ts',
    source_pages: officialSourcePages(),
    symbols: Object.entries(counts).flatMap(([doc_page, n]) =>
      Array.from({ length: n }, (_, i) => ({
        symbol: `--mock-${doc_page}-${i}`,
        type: 'cli_flag' as const,
        description: 'A mocked symbol',
        doc_min_version: null,
        doc_page,
      }))
    ),
  });
  const atFloor = () =>
    Object.fromEntries(Object.entries(PAGE_MIN_SYMBOLS).map(([p, n]) => [p, n as number]));

  it('accepts an index where every floored page meets its floor', () => {
    expect(() => assertDocsCoverage(index(atFloor()))).not.toThrow();
  });

  it('throws naming the page that collapsed', () => {
    const counts = { ...atFloor(), 'settings-reference': 0 };
    expect(() => assertDocsCoverage(index(counts))).toThrow(
      /"settings-reference" yielded 0 of the/
    );
  });

  it('throws on a partial collapse, not only an empty page', () => {
    const counts = { ...atFloor(), 'env-vars': 1 };
    expect(() => assertDocsCoverage(index(counts))).toThrow(/"env-vars" yielded 1 of the/);
  });

  it('ignores a page with no floor', () => {
    expect(() => assertDocsCoverage(index({ ...atFloor(), glossary: 0 }))).not.toThrow();
  });
});

describe('knownSettingsKeys', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claustodian-docs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const write = async (body: unknown) => {
    const p = join(dir, 'obs.json');
    await writeFile(p, JSON.stringify(body), 'utf-8');
    return p;
  };

  it('reads config_key paths and ignores every other type', async () => {
    const p = await write({
      symbols: [
        { type: 'config_key', symbol: 'permissions.allow' },
        { type: 'config_key', symbol: 'advisorModel' },
        { type: 'cli_flag', symbol: '--print' },
        { type: 'env_var', symbol: 'CLAUDE_CODE_SAFE_MODE' },
      ],
    });
    const keys = await knownSettingsKeys(p);
    expect([...keys].sort()).toEqual(['advisorModel', 'permissions.allow']);
  });

  it('throws rather than resolving key paths against an empty schema', async () => {
    // Silently returning an empty set would make every namespaced settings row
    // unresolvable, which reads as "the page documents nothing" — a whole lane
    // quietly going dark.
    await expect(knownSettingsKeys(await write({ symbols: [] }))).rejects.toThrow(
      /holds no config_key observations/
    );
    await expect(knownSettingsKeys(await write({}))).rejects.toThrow(
      /holds no config_key observations/
    );
    await expect(
      knownSettingsKeys(await write({ symbols: [{ type: 'cli_flag', symbol: '--print' }] }))
    ).rejects.toThrow(/holds no config_key observations/);
  });
});

describe('buildDocsIndex — per-scope descriptions', () => {
  it('captures scope_descriptions for a flag documented under >1 subcommand with different text', () => {
    const md = [
      '## plugin init',
      '| `-f, --force` | Overwrite an existing `.claude-plugin/` at the target |',
      '## plugin tag',
      '| `-f, --force` | Create the tag even if the working tree is dirty |',
    ].join('\n');
    const force = buildDocsIndex([{ page: 'plugins-reference', markdown: md }]).symbols.find(
      (s) => s.symbol === '--force'
    );
    // The primary description stays the first (plugin init) one.
    expect(force?.description).toBe('Overwrite an existing `.claude-plugin/` at the target');
    expect(force?.scope_descriptions).toEqual({
      'plugin init': 'Overwrite an existing `.claude-plugin/` at the target',
      'plugin tag': 'Create the tag even if the working tree is dirty',
    });
    // The internal `scope` marker must never reach docs.json.
    expect(Object.prototype.hasOwnProperty.call(force, 'scope')).toBe(false);
  });

  it('keeps the first description when a flag repeats under the same subcommand', () => {
    const md = [
      '## plugin init',
      '| `--force` | first init |',
      '| `--force` | second init ignored |',
      '## plugin tag',
      '| `--force` | tag text |',
    ].join('\n');
    const force = buildDocsIndex([{ page: 'plugins-reference', markdown: md }]).symbols.find(
      (s) => s.symbol === '--force'
    );
    expect(force?.scope_descriptions).toEqual({
      'plugin init': 'first init',
      'plugin tag': 'tag text',
    });
  });

  it('omits the map when the text is identical under each subcommand', () => {
    const md = [
      '## plugin init',
      '| `--force` | Force it |',
      '## plugin tag',
      '| `--force` | Force it |',
    ].join('\n');
    const force = buildDocsIndex([{ page: 'plugins-reference', markdown: md }]).symbols.find(
      (s) => s.symbol === '--force'
    );
    expect(force?.scope_descriptions).toBeUndefined();
  });

  it('omits the map for a flag under a single subcommand', () => {
    const md = ['## plugin init', '| `--force` | Overwrite the dir |'].join('\n');
    const force = buildDocsIndex([{ page: 'plugins-reference', markdown: md }]).symbols.find(
      (s) => s.symbol === '--force'
    );
    expect(force?.scope_descriptions).toBeUndefined();
  });

  it('ignores prose section headings (capitals / articles), keeping them out of the map', () => {
    const md = [
      '## CLI flags',
      '| `--name` | The session name |',
      '## Start a Remote Control session',
      '| `--name` | Name the remote session |',
    ].join('\n');
    const name = buildDocsIndex([{ page: 'cli-reference', markdown: md }]).symbols.find(
      (s) => s.symbol === '--name'
    );
    expect(name?.scope_descriptions).toBeUndefined();
  });

  it('never attaches per-scope descriptions to a non-flag symbol', () => {
    const md = ['## plugin init', '| `/foo` | one |', '## plugin tag', '| `/foo` | two |'].join(
      '\n'
    );
    const foo = buildDocsIndex([{ page: 'plugins-reference', markdown: md }]).symbols.find(
      (s) => s.symbol === '/foo'
    );
    expect(foo?.scope_descriptions).toBeUndefined();
  });
});
