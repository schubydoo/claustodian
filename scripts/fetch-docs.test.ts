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
  DOCS_BASE,
  knownSettingsKeys,
  main,
  officialSourcePages,
  PAGE_BASELINE_MIN_VERSION,
  PAGE_MIN_SYMBOLS,
  parseDocPage,
  TYPE_MIN_SYMBOLS,
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
  // The whole slug, not the last segment: `plugins/cli-reference` must not read
  // as `cli-reference`.
  const page = url.slice(DOCS_BASE.length).replace(/\.md$/, '');
  const floor = PAGE_MIN_SYMBOLS[page as keyof typeof PAGE_MIN_SYMBOLS] ?? 0;
  const rows = Array.from({ length: floor }, (_, i) => i);
  if (page === 'settings-reference') {
    return ['## Tools', ...rows.map((i) => `### \`mockKey${i}\`\n\nA mocked settings key.`)].join(
      '\n\n'
    );
  }
  if (page === 'plugins/mods/reference') {
    // One namespace row per method keeps the yield equal to the floor, and the
    // events clear their type floor.
    const events = Array.from({ length: TYPE_MIN_SYMBOLS.mod_event ?? 0 }, (_, i) => i);
    const sites = Array.from({ length: TYPE_MIN_SYMBOLS.mod_render_site ?? 0 }, (_, i) => i);
    const elements = Array.from({ length: TYPE_MIN_SYMBOLS.mod_element ?? 0 }, (_, i) => i);
    return [
      '## Elements',
      '| Element | Main props |',
      '| :- | :- |',
      ...elements.map((i) => `| \`MockEl${String.fromCharCode(65 + i)}\` | none |`),
      '## Render sites',
      '| Site | `e.props` |',
      '| :- | :- |',
      ...sites.map((i) => `| \`MockSite${String.fromCharCode(65 + i)}\` | none |`),
      '## Events',
      '| Event | Fires when |',
      '| :- | :- |',
      ...events.map((i) => `| \`mock.event${i}\` | A mocked event fires |`),
      '## Mods API methods',
      '| Namespace | Methods |',
      '| :- | :- |',
      ...rows.map((i) => `| \`$.mock${i}\` | \`call\` |`),
    ].join('\n');
  }
  const cell = (i: number): string => {
    if (page === 'commands') return `/mock-${i}`;
    if (page === 'env-vars') return `MOCK_ENV_${i}`;
    return `--${page.replace('/', '-')}-mock-${i}`;
  };
  const table = rows.map((i) => `| \`${cell(i)}\` | A mocked symbol |`).join('\n');
  if (page === 'self-hosted-environments-reference') {
    // The runner section, plus the orchestrator paragraph SCOPE_INHERITANCE reads
    // and a runner row for each flag it names.
    const inherited = [
      '--api-url',
      '--environment-secret-file',
      '--hooks-dir',
      '--health-port',
      '--log-level',
    ];
    return [
      '## Runner CLI flags',
      '| Flag | Description |',
      '| :- | :- |',
      table,
      ...inherited.map((flag) => `| \`${flag}\` | A mocked runner flag |`),
      '## Orchestrator CLI flags',
      `It accepts ${inherited.map((f) => `\`${f}\``).join(', ')} with the same defaults as the runner.`,
    ].join('\n');
  }
  // These pages publish only from an allowlisted section; the first one will do.
  const section = {
    'env-vars': 'Variables',
    'monitoring-usage': 'Common configuration variables',
    'plugin-evals': 'Command options',
    ultrareview: 'Run ultrareview non-interactively',
  }[page];
  return section ? `## ${section}\n\n${table}` : table;
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

  it('skips the /path placeholder in the marketplace source table (denylist)', () => {
    // The real cell from plugins/cli-reference: `/path` is the first span the
    // command pattern accepts, so without the entry it published as a command.
    expect(symbolFromCell('`./path`, `../path`, `/path`, or `~/path` to a directory')).toBeNull();
    expect(symbolFromCell('`/plugin`')).toEqual({ symbol: '/plugin', type: 'command' });
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
      'cli-reference',
      '| `ANTHROPIC_SMALL_FAST_MODEL` | \\[DEPRECATED] a\\_b |'
    )[0];
    expect(entry?.description).toBe('[DEPRECATED] a_b');
  });

  it('keeps a backslash literal inside an inline code span (not treated as an escape)', () => {
    const entry = parseDocPage('cli-reference', '| `--xray` | uses `foo\\_bar` as a key |')[0];
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

  it('reads env-vars symbols only from the Variables section', () => {
    // The live page's scrub section: an example table of variables Claude Code
    // strips or keeps in a child environment, not variables it reads. Its
    // CLAUDE_CONFIG_DIR row dates the scrub behaviour, not the variable.
    const page = [
      '| `LEADING_TABLE_VAR` | A table before any heading |',
      '## Variables',
      '| Variable | Purpose |',
      '| :- | :- |',
      '| `CLAUDE_CONFIG_DIR` | Override the configuration directory |',
      '## What the subprocess environment scrub removes',
      '| Example variable | What the scrub does |',
      '| :- | :- |',
      '| `NPM_TOKEN`, `DB_PASSWORD` | Removes it, because the name looks like a credential |',
      '| `CLAUDE_CONFIG_DIR` | Removes it. Requires Claude Code v2.1.251 or later |',
      '| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` | Leaves it in place, whatever it holds |',
    ].join('\n');
    const entries = parseDocPage('env-vars', page);
    expect(entries.map((e) => e.symbol)).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(buildDocsIndex([{ page: 'env-vars', markdown: page }]).symbols).toMatchObject([
      { symbol: 'CLAUDE_CONFIG_DIR', doc_min_version: null },
    ]);
    // The same rows on a page with no section list still publish.
    expect(parseDocPage('cli-reference', page).map((e) => e.symbol)).toContain('NPM_TOKEN');
  });

  it('does not resurrect a deliberately-escaped link into active markdown', () => {
    const entry = parseDocPage('cli-reference', '| `--xray` | see \\[text\\]\\(url\\) here |')[0];
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

  it('accepts an index fetched before a later page joined DOC_PAGES', () => {
    // A code PR that adds a page cannot also regenerate data/docs.json, so the
    // committed index lags by that page until the next docs refresh.
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: official.slice(0, -1),
        symbols: [entry('cli-reference')],
      })
    ).not.toThrow();
  });

  it('rejects source_pages that are empty, duplicated or out of order', () => {
    for (const source_pages of [[], [official[0], official[0]], [official[1], official[0]]]) {
      expect(() =>
        assertOfficialDocs({
          $generated_by: '',
          source_pages: source_pages as string[],
          symbols: [],
        })
      ).toThrow(/source_pages/);
    }
  });

  it('rejects an entry from an official page the index did not fetch', () => {
    expect(() =>
      assertOfficialDocs({
        $generated_by: '',
        source_pages: official.slice(0, 1),
        symbols: [entry('commands')],
      })
    ).toThrow(/doc_page/);
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
  const index = (
    counts: Record<string, number>,
    modEvents = TYPE_MIN_SYMBOLS.mod_event ?? 0,
    modMethods = TYPE_MIN_SYMBOLS.mod_method ?? 0,
    modRenderSites = TYPE_MIN_SYMBOLS.mod_render_site ?? 0,
    modElements = TYPE_MIN_SYMBOLS.mod_element ?? 0
  ) => ({
    $generated_by: 'scripts/fetch-docs.ts',
    source_pages: officialSourcePages(),
    symbols: [
      ...Object.entries(counts).flatMap(([doc_page, n]) =>
        Array.from({ length: n }, (_, i) => ({
          symbol: `--mock-${doc_page}-${i}`,
          type: 'cli_flag' as const,
          description: 'A mocked symbol',
          doc_min_version: null,
          doc_page,
        }))
      ),
      // Extra to the page counts above, so they never lift a page over its floor.
      ...Array.from({ length: modEvents }, (_, i) => ({
        symbol: `mock.event${i}`,
        type: 'mod_event' as const,
        description: 'A mocked event fires',
        doc_min_version: null,
        doc_page: 'mock-types-page',
      })),
      ...Array.from({ length: modMethods }, (_, i) => ({
        symbol: `$.mock.method${i}`,
        type: 'mod_method' as const,
        description: '',
        doc_min_version: null,
        doc_page: 'mock-types-page',
      })),
      ...Array.from({ length: modRenderSites }, (_, i) => ({
        symbol: `MockSite${i}`,
        type: 'mod_render_site' as const,
        description: '',
        doc_min_version: null,
        doc_page: 'mock-types-page',
      })),
      ...Array.from({ length: modElements }, (_, i) => ({
        symbol: `MockEl${i}`,
        type: 'mod_element' as const,
        description: '',
        doc_min_version: null,
        doc_page: 'mock-types-page',
      })),
    ],
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

  it('throws when one type collapses while its page still clears the page floor', () => {
    // The mods reference page: the method rows alone clear the page floor.
    expect(() => assertDocsCoverage(index(atFloor(), 1))).toThrow(/1 mod_event symbols/);
    // And the other way round: the event rows alone clear the page floor, so an
    // emptied method table must trip the method floor.
    expect(() => assertDocsCoverage(index(atFloor(), TYPE_MIN_SYMBOLS.mod_event, 0))).toThrow(
      /0 mod_method symbols/
    );
  });

  it('throws on a partial collapse, not only an empty page', () => {
    const counts = { ...atFloor(), 'env-vars': 1 };
    expect(() => assertDocsCoverage(index(counts))).toThrow(/"env-vars" yielded 1 of the/);
  });

  it('throws when the plugin manifest page keeps only one of its env vars', () => {
    const counts = { ...atFloor(), 'plugins/manifest-reference': 1 };
    expect(() => assertDocsCoverage(index(counts))).toThrow(
      /"plugins\/manifest-reference" yielded 1 of the 2/
    );
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

describe('parseDocPage — mods reference', () => {
  // Rows copied verbatim from the mods reference page, plus an events table and a
  // later section, which must contribute nothing.
  const MODS_PAGE = [
    '# Mods reference',
    '## Events',
    '| Event | Fires when | A hook can return |',
    '| :- | :- | :- |',
    '| [`tool.call`](/docs/en/plugins/mods/events#guard) | A tool is about to run | `next(e)` |',
    '## Mods API methods',
    'The mods API is the `$` argument every hook receives.',
    '| Namespace | Methods |',
    '| :- | :- |',
    "| `$.plugin` | `name`, `root`: this plugin's name and directory |",
    '| [`$.ui`](/docs/en/plugins/mods/interface#pick-where-to-draw) | `resolve`, `toast`, `blit` |',
    "| `$.agent` | `register`, `spawn`, `list`. `list()` returns this session's subagents and teammates, each with a `status` of `pending`, `running`, `waiting`, `idle`, `completed`, `failed`, or `killed`, where `idle` and `waiting` require Claude Code v2.1.289 or later. |",
    '| [`$.state`](/docs/en/plugins/mods/interface#keep-a-value-in-\\$-state) | Reactive state: `get`, `set`, with the helpers `atom`, `read`, `update`, `derive`, and `memberOf` imported from `claude-code` |',
    '| `$.telemetry` | `log`, `mark`. A record is sent only when Claude Code or a built-in mod makes the call. |',
    '## Render sites',
    '| Site | `e.props` |',
    '| :- | :- |',
    '| `Pane` | `title`, `$.fake.site` |',
  ].join('\n');

  const parsed = () => parseDocPage('plugins/mods/reference', MODS_PAGE);

  const methods = () => parsed().filter((e) => e.type === 'mod_method');

  it('reads each namespace row as one mod_method per listed method', () => {
    expect(methods().map((e) => e.symbol)).toEqual([
      '$.plugin.name',
      '$.plugin.root',
      '$.ui.resolve',
      '$.ui.toast',
      '$.ui.blit',
      '$.agent.register',
      '$.agent.spawn',
      '$.agent.list',
      '$.state.get',
      '$.state.set',
      '$.telemetry.log',
      '$.telemetry.mark',
    ]);
  });

  it('takes only the leading method list, not words from the notes after it', () => {
    const symbols = methods().map((e) => e.symbol);
    for (const word of ['pending', 'idle', 'atom', 'memberOf', 'claude-code']) {
      expect(symbols.some((s) => s.endsWith(`.${word}`))).toBe(false);
    }
  });

  it('dates nothing from a version that a row note gives for something else', () => {
    // `$.agent` says statuses require v2.1.289; that is not when `list` appeared.
    expect(methods().every((e) => e.doc_min_version === null)).toBe(true);
  });

  it('reads a list ending in "or", and names written as calls', () => {
    const page = [
      '## Mods API methods',
      '| Namespace | Methods |',
      '| :- | :- |',
      '| `$.a` | `one`, `two`, or `three` |',
      '| `$.c` | `list()`, `get()` |',
    ].join('\n');
    expect(parseDocPage('plugins/mods/reference', page).map((e) => e.symbol)).toEqual([
      '$.a.one',
      '$.a.two',
      '$.a.three',
      '$.c.list',
      '$.c.get',
    ]);
  });

  it('refuses a row in the methods table that it cannot read', () => {
    // The page's floor catches a large loss; a single unreadable row would otherwise
    // drop its methods without a word.
    for (const row of [
      '| `$.ui` | `get_all`, `status` |',
      // A readable prefix must not hide an unreadable name later in the list.
      '| `$.ui` | `toast`, `get_all`, `status` |',
      '| $.ui | `toast` |',
      '| `$.ui` |',
      '|',
    ]) {
      const page = ['## Mods API methods', '| Namespace | Methods |', '| :- | :- |', row].join(
        '\n'
      );
      expect(() => parseDocPage('plugins/mods/reference', page)).toThrow(/Mods API methods/);
    }
  });

  it('has a coverage floor, so an emptied section fails instead of reading as removals', () => {
    expect(PAGE_MIN_SYMBOLS['plugins/mods/reference']).toBeGreaterThan(0);
  });
});

describe('parseDocPage — mods reference events', () => {
  // Rows copied verbatim from the page's Events section, with a field table between
  // two event tables, as the page has under `tool.check` and `skill.prompt`.
  const EVENTS_PAGE = [
    '## Events',
    '### Tools',
    '| Event | Fires when | A hook can return |',
    '| :- | :- | :- |',
    '| [`tool.call`](/docs/en/plugins/mods/events#guard-or-change-a-tool-call) | A tool is about to run | `next(e)`, `{ deny: reason }`, or `{ result }` |',
    '#### Source and frontmatter fields on `skill.prompt`',
    '| Field | Type | What it holds |',
    '| :- | :- | :- |',
    '| `e.source` | string | Who provides the skill |',
    '### Prompts and what Claude reads',
    '| Event | Fires when | A hook can return |',
    '| :- | :- | :- |',
    '| `prompt.fill`, `prompt.suggest` | Text is about to go into the prompt box as a draft, or as a dim suggestion | `next(e)` with changed text |',
    '| `prompt.mention` | Claude Code is about to read a file that a prompt @-mentions. Requires Claude Code v2.1.290 or later. | `next({ ...e, path })` to read a different file, or `{ deny: reason }` |',
    '### Interface',
    '| Event | Fires when |',
    '| :- | :- |',
    '| `ui.close` | A pane is about to close. `e.id` is the pane. |',
    '## Mods API methods',
    '| Namespace | Methods |',
    '| :- | :- |',
    '| `$.ui` | `close` |',
  ].join('\n');
  const events = () =>
    parseDocPage('plugins/mods/reference', EVENTS_PAGE).filter((e) => e.type === 'mod_event');

  it('reads every event of every Events table, two names to a row where the row has two', () => {
    expect(events().map((e) => e.symbol)).toEqual([
      'tool.call',
      'prompt.fill',
      'prompt.suggest',
      'prompt.mention',
      'ui.close',
    ]);
  });

  it('reads no name from a table of event fields', () => {
    expect(events().some((e) => e.symbol.startsWith('e.'))).toBe(false);
  });

  it('describes each event with when it fires, and dates it from a version in that cell', () => {
    const byName = new Map(events().map((e) => [e.symbol, e]));
    expect(byName.get('tool.call')).toMatchObject({
      description: 'A tool is about to run',
      doc_min_version: null,
    });
    expect(byName.get('prompt.mention')?.doc_min_version).toBe('2.1.290');
  });

  it('refuses a row of an Events table that names no event', () => {
    const page = [
      '## Events',
      '| Event | Fires when |',
      '| :- | :- |',
      '| tool.call | A tool is about to run |',
    ].join('\n');
    expect(() => parseDocPage('plugins/mods/reference', page)).toThrow(/Events table/);
  });

  it('reads an event table that moved under another heading', () => {
    const page = [
      '## Interface events',
      '| Event | Fires when |',
      '| :- | :- |',
      '| `ui.close` | A pane is about to close |',
      '## Render sites',
      '| Site | `e.props` |',
      '| :- | :- |',
      '| `Pane` | `title` |',
    ].join('\n');
    expect(
      parseDocPage('plugins/mods/reference', page)
        .filter((e) => e.type === 'mod_event')
        .map((e) => e.symbol)
    ).toEqual(['ui.close']);
  });

  it('refuses a table in the Events section whose header it does not know', () => {
    // A renamed event table would otherwise drop its events without a word.
    const page = [
      '## Events',
      '| Event name | Fires when |',
      '| :- | :- |',
      '| `ui.close` | A pane is about to close |',
    ].join('\n');
    expect(() => parseDocPage('plugins/mods/reference', page)).toThrow(/neither an event table/);
  });

  it('has its own floor, so an emptied Events section fails beside a full method table', () => {
    expect(TYPE_MIN_SYMBOLS.mod_event).toBeGreaterThan(0);
  });
});

describe('parseDocPage — mods reference render sites', () => {
  const sites = (page: string) =>
    parseDocPage('plugins/mods/reference', page)
      .filter((e) => e.type === 'mod_render_site')
      .map((e) => e.symbol);

  it('reads every site of the table, several to a row and through links', () => {
    const page = [
      '## Render sites',
      '| Site | `e.props` | `e.requestId` | Rendered on |',
      '| :- | :- | :- | :- |',
      "| [`Pane`](/docs/en/plugins/mods/interface#pick-where-to-draw) | `title`, `view` | The pane's `id` | Terminal |",
      "| `ToolUse`, `ToolResult`, `ToolGroup` | The tool's name | The tool call id | Terminal |",
      '## Elements',
      '| Element | Main props |',
      '| :- | :- |',
      '| `Box` | `key` |',
    ].join('\n');
    expect(sites(page)).toEqual(['Pane', 'ToolUse', 'ToolResult', 'ToolGroup']);
  });

  it('refuses an unknown header, and a row that names no site', () => {
    const table = (header: string, row: string) =>
      ['## Render sites', header, '| :- | :- |', row].join('\n');
    expect(() => sites(table('| Component | What |', '| `Pane` | x |'))).toThrow(
      /other than "Site"/
    );
    expect(() => sites(table('| Site | What |', '| Pane | x |'))).toThrow(/other than site names/);
  });

  it('refuses a cell with words beside the names, and a second table', () => {
    const page = (...rows: string[]) =>
      ['## Render sites', '| Site | What |', '| :- | :- |', ...rows].join('\n');
    expect(() => sites(page('| `CommandOutput` (wraps a `Box`) | x |'))).toThrow(
      /other than site names/
    );
    expect(() =>
      sites(page('| `Pane` | x |', '', '| Site | What |', '| :- | :- |', '| `Elements` | y |'))
    ).toThrow(/second table/);
  });

  it('skips a Render sites example inside fenced code', () => {
    const page = [
      '## Elements',
      '```md',
      '## Render sites',
      '| Site | What |',
      '| :- | :- |',
      '| `Fake` | x |',
      '```',
    ].join('\n');
    expect(sites(page)).toEqual([]);
  });
});

describe('parseDocPage — mods reference elements', () => {
  const elements = (page: string) =>
    parseDocPage('plugins/mods/reference', page)
      .filter((e) => e.type === 'mod_element')
      .map((e) => e.symbol);
  const ELEMENTS = [
    '## Elements',
    '| Element | Main props | Terminal |',
    '| :- | :- | :-: |',
    '| [`Box`](/docs/en/plugins/mods/interface#build-a-tree-from-elements) | `key` | ✓ |',
    '| `Svg` | An SVG document | |',
    '',
    '### `Box` border styles',
    '| `borderStyle` | What the terminal draws |',
    '| :- | :- |',
    "| `'single'` | Thin lines |",
  ];

  it('reads the Element table, linked or plain, and skips the prop tables', () => {
    expect(elements(ELEMENTS.join('\n'))).toEqual(['Box', 'Svg']);
  });

  it('refuses a table headed like an element table, and reads a version note', () => {
    const split = [
      ...ELEMENTS.slice(0, 4),
      '',
      '| Desktop element | x |',
      '| :- | :- |',
      '| `Svg` | y |',
    ];
    expect(() => elements(split.join('\n'))).toThrow(/headed like an element table/);
    const noted = ELEMENTS.map((l) =>
      l.startsWith('| `Svg`') ? '| `Svg` | Requires Claude Code v2.1.290 or later | |' : l
    );
    const svg = parseDocPage('plugins/mods/reference', noted.join('\n')).find(
      (e) => e.symbol === 'Svg'
    );
    expect(svg?.doc_min_version).toBe('2.1.290');
  });

  it('refuses a second Element table, and a cell holding more than one name', () => {
    const second = [...ELEMENTS, '', '| Element | x |', '| :- | :- |', '| `Fake` | y |'];
    expect(() => elements(second.join('\n'))).toThrow(/second Element table/);
    const odd = ELEMENTS.map((l) => (l.startsWith('| `Svg`') ? '| `Svg` (or `Box`) | x | |' : l));
    expect(() => elements(odd.join('\n'))).toThrow(/other than an element name/);
  });
});

describe('parseDocPage — subcommand-scoped reference pages', () => {
  const RUNNER = [
    '## Runner CLI flags',
    '| Flag | Env var | Default | Description |',
    '| :- | :- | :- | :- |',
    '| `--api-url <url>` | none | `https://api.anthropic.com` | API base URL. Override only for testing. |',
    '| `--health-port <port>` | `SELF_HOSTED_RUNNER_HEALTH_PORT` | `8080` | Port for the `/healthz` listener. |',
    '| `--base-dir <path>` | `SELF_HOSTED_RUNNER_BASE_DIR` | unset | Directory for repository checkouts. |',
    '## Orchestrator CLI flags',
    'The `self-hosted-runner orchestrator` subcommand accepts `--api-url`, `--environment-secret-file`, `--hooks-dir`, `--health-port`, and `--log-level` with the same defaults as the runner.',
    '| Flag | Default | Description |',
    '| :- | :- | :- |',
    '| `--min-idle <n>` | `0` | Keep at least N idle session slots free. |',
    '## Prometheus metrics',
    '| Series | Notes |',
    '| :- | :- |',
    '| `--not-a-flag` | A metric series |',
  ];
  // The other two inherited flags need runner rows of their own.
  const page = (lines = RUNNER) =>
    [
      ...lines.slice(0, 6),
      '| `--environment-secret-file <path>` | none | unset | Path to the environment secret. |',
      '| `--hooks-dir <path>` | none | unset | Directory of lifecycle hook scripts. |',
      '| `--log-level <level>` | none | `info` | `info` or `debug` |',
      ...lines.slice(6),
    ].join('\n');
  const index = (markdown: string) =>
    buildDocsIndex([{ page: 'self-hosted-environments-reference', markdown }]).symbols;
  const entry = (markdown: string, symbol: string) =>
    index(markdown).find((e) => e.symbol === symbol);

  it('reads the description column by its header, not by position', () => {
    expect(entry(page(), '--base-dir')?.description).toBe('Directory for repository checkouts.');
    const evals = [
      '## Command options',
      '| Option | Default | Effect |',
      '| :- | :- | :- |',
      '| `--keep-temp` | off | Keep every run sandbox |',
    ].join('\n');
    expect(parseDocPage('plugin-evals', evals)[0]?.description).toBe('Keep every run sandbox');
  });

  it('records the scopes a description covers, the inherited ones included', () => {
    expect(entry(page(), '--base-dir')?.doc_scopes).toEqual(['self-hosted-runner']);
    expect(entry(page(), '--min-idle')?.doc_scopes).toEqual(['self-hosted-runner orchestrator']);
    // Named in the orchestrator paragraph: the runner text covers both scopes.
    expect(entry(page(), '--api-url')?.doc_scopes).toEqual([
      'self-hosted-runner',
      'self-hosted-runner orchestrator',
    ]);
    // `scope` is internal and never reaches docs.json.
    expect(entry(page(), '--api-url')).not.toHaveProperty('scope');
  });

  it('reads the Env var column as env vars with the row description', () => {
    expect(entry(page(), 'SELF_HOSTED_RUNNER_HEALTH_PORT')).toMatchObject({
      type: 'env_var',
      description: 'Port for the `/healthz` listener.',
      doc_page: 'self-hosted-environments-reference',
    });
    expect(entry(page(), 'SELF_HOSTED_RUNNER_BASE_DIR')?.description).toBe(
      'Directory for repository checkouts.'
    );
    // A flag row still yields the flag, and "none" yields no env var.
    expect(entry(page(), '--health-port')?.type).toBe('cli_flag');
    expect(index(page()).filter((e) => e.type === 'env_var')).toHaveLength(2);
  });

  it('reads only the allowlisted sections', () => {
    expect(entry(page(), '--not-a-flag')).toBeUndefined();
  });

  it('refuses the page when the orchestrator paragraph drops "same defaults"', () => {
    const changed = RUNNER.map((line) =>
      line.replace('with the same defaults as the runner', 'too')
    );
    expect(() => index(page(changed))).toThrow(/accepts the runner flags with the same defaults/);
  });

  it('refuses an inherited flag that has no runner row to copy', () => {
    const md = page().replace(/^\| `--log-level.*$/m, '');
    expect(() => index(md)).toThrow(/names --log-level, which has no "self-hosted-runner" row/);
  });

  it('falls back to the second cell for a short row on a page without an allowlist', () => {
    const md =
      '## Flags\n| Flag | Default | Description |\n| :- | :- | :- |\n| `--short` | Short row text |';
    expect(parseDocPage('plugins/cli-reference', md)[0]?.description).toBe('Short row text');
    // A short row with no Env var cell yields only the flag.
    const env =
      '## Flags\n| Flag | Description | Env var |\n| :- | :- | :- |\n| `--short` | Short row text |';
    expect(parseDocPage('plugins/cli-reference', env).map((e) => e.symbol)).toEqual(['--short']);
  });

  it('refuses a table it cannot read by column', () => {
    // A renamed header would otherwise publish the Env var cell as the text.
    const renamed = RUNNER.map((line) =>
      line.replace('| Default | Description |', '| Default | Details |')
    );
    expect(() => index(page(renamed))).toThrow(/names no Description or Effect column/);
    // A stray line makes the next data row read as a header with no named column.
    const stray = [...RUNNER.slice(0, 4), 'A note inside the table.', ...RUNNER.slice(4)];
    expect(() => index(page(stray))).toThrow(/names no Description or Effect column/);
    // A row that lost its last cell would read the Default cell.
    const short = RUNNER.map((line) =>
      line.startsWith('| `--base-dir') ? '| `--base-dir <path>` | none | unset |' : line
    );
    expect(() => index(page(short))).toThrow(/has 3 cells under a 4-cell header/);
  });

  it('refuses the page when the orchestrator paragraph stops naming an inherited flag', () => {
    const changed = RUNNER.map((line) => line.replace('`--hooks-dir`, ', ''));
    expect(() => index(page(changed))).toThrow(/--hooks-dir with the same defaults/);
  });

  it('keeps the runner text for a flag an earlier page wins', () => {
    const rc = [
      '## Start a Remote Control session',
      '| Flag | Description |',
      '| - | - |',
      '| `--capacity <N>` | Maximum number of concurrent sessions. Default is 32. |',
    ].join('\n');
    const runner = page([
      ...RUNNER.slice(0, 6),
      '| `--capacity <n>` | none | `1` | Maximum concurrent sessions this runner handles. |',
      ...RUNNER.slice(6),
    ]);
    const capacity = buildDocsIndex([
      { page: 'remote-control', markdown: rc },
      { page: 'self-hosted-environments-reference', markdown: runner },
    ]).symbols.find((e) => e.symbol === '--capacity');
    expect(capacity).toMatchObject({
      description: 'Maximum number of concurrent sessions. Default is 32.',
      doc_page: 'remote-control',
      doc_scopes: ['remote-control'],
      scope_descriptions: {
        'remote-control': 'Maximum number of concurrent sessions. Default is 32.',
        'self-hosted-runner': 'Maximum concurrent sessions this runner handles.',
      },
    });
  });

  it('sets no doc_scopes on a page without section scopes', () => {
    const md = '## plugin init\n| Flag | Description |\n| :- | :- |\n| `--force` | Overwrite it |';
    const winner = buildDocsIndex([{ page: 'plugins/cli-reference', markdown: md }]).symbols[0];
    expect(winner?.doc_scopes).toBeUndefined();
  });
});
