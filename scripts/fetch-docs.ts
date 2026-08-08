// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Docs lane — fetch the official Claude Code reference pages (public,
 * first-party markdown) and extract an authoritative `symbol -> description`
 * index, plus a first-party `first_seen` signal where a page annotates one.
 *
 * The changelog lane knows *when* a symbol was observed but describes it with
 * whatever bullet first named it — which is often an incidental mention (a fix
 * that happens to reference the flag), not a definition. These reference pages
 * are the canonical "what does this do", and several rows carry a `min-version`
 * annotation that is an official introduction version. This script turns those
 * tables into `data/docs.json`; the snapshot builder overlays it.
 *
 * Fetch is kept separate from parsing so the parser is unit-testable against
 * fixture markdown with no network.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { isMain } from './lib.js';

export const DOCS_BASE = 'https://code.claude.com/docs/en/';

/** Reference pages, in priority order — the first page to define a symbol wins. */
export const DOC_PAGES = [
  'cli-reference',
  'commands',
  'env-vars',
  'tools-reference',
  'interactive-mode',
  'checkpointing',
  'hooks',
  'plugins-reference',
  'channels-reference',
  'glossary',
  'remote-control',
  'settings',
] as const;

export type DocSymbolType = 'cli_flag' | 'command' | 'env_var' | 'config_key';

/**
 * Per-page baseline `min-version` for pages that state a feature-level
 * introduction version in prose but don't repeat it in every flag's table cell.
 * A symbol parsed from such a page inherits this when its own cell carries no
 * `min-version` marker; a cell-level marker always wins (later-added flags keep
 * their own version). Curated from the page's own official callout.
 *
 * `remote-control`: the page states "Remote Control requires Claude Code v2.1.51
 * or later," so its server-mode flags that carry no per-cell marker (`--sandbox`,
 * `--no-sandbox`, `--spawn`, …) date to 2.1.51; flags added later (`--continue`,
 * `--session-id` → 2.1.200) keep their cell marker. Provenance stays `docs`.
 */
export const PAGE_BASELINE_MIN_VERSION: Partial<Record<(typeof DOC_PAGES)[number], string>> = {
  'remote-control': '2.1.51',
};

/** Generic OS/shell env vars a doc may reference but that aren't Claude Code symbols. */
const ENV_DENYLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'PWD',
  'TMPDIR',
  'EDITOR',
  'VISUAL',
  // Not an OS var: a docs-prose concept label the env matcher grabbed from a
  // plugins-reference skill-type table (`| SKILL | A plain skill named foo |`).
  // A stopgap until conceptual pages are curated out (see roadmap).
  'SKILL',
]);

export interface DocEntry {
  symbol: string;
  type: DocSymbolType;
  description: string;
  doc_min_version: string | null;
  doc_page: string;
  /**
   * Overrides the categorizer for this symbol. Set only where the page itself
   * distinguishes a surface the default categorizer cannot see — currently the
   * `~/.claude.json` global-config keys, which are config keys but are ignored
   * in `settings.json`.
   */
  category?: string;
}

export interface DocsIndex {
  $generated_by: string;
  source_pages: string[];
  symbols: DocEntry[];
}

/** Strip `[text](url)` links to their text. Runs on the whole cell because link
 * text frequently contains a code span (`` [`setting`](url) `` in these docs). */
function stripLinks(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/** Unescape Markdown backslash escapes (`\[`, `\*`, `\_`, …) but ONLY outside
 * inline code spans — a backslash between backticks is literal in Markdown, not
 * an escape, so `` `foo\_bar` `` keeps its backslash. Odd split segments are the
 * code spans; they pass through untouched. The class is CommonMark's ASCII
 * punctuation set. */
function unescapeOutsideCode(s: string): string {
  return s
    .split(/(`[^`]*`)/)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\\([!-/:-@[-`{-~])/g, '$1')))
    .join('');
}

/**
 * Reduce a raw Markdown table cell to the plain text we publish as a description:
 * drop MDX comment blocks, strip `[text](url)` links, and unescape backslash
 * escapes outside code spans.
 *
 * Links are stripped, then escapes unescaped, then links stripped AGAIN: the
 * second pass catches a deliberately-escaped `\[text\]\(url\)` that the unescape
 * turns back into `[text](url)` — otherwise it would be published as an active
 * link the official docs had intentionally inert. MDX comments go first (they
 * never hold real text).
 */
function cleanCell(cell: string): string {
  const withoutComments = cell.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const cleaned = stripLinks(unescapeOutsideCode(stripLinks(withoutComments)));
  return cleaned.replace(/\s+/g, ' ').trim();
}

/** An official introduction version, if the cell states one. */
function minVersion(cell: string): string | null {
  const m =
    cell.match(/min-version:\s*(\d+\.\d+\.\d+)/) ??
    cell.match(/(?:Available in|Requires) Claude Code v(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

/**
 * The trackable symbol named by a table's first cell, or null. Recognises a
 * `--flag`, a `/command`, or an `ALL_CAPS` environment variable inside the
 * cell's first backtick span; skips `claude sub command` rows and prose.
 */
function symbolFromInner(inner: string): { symbol: string; type: DocSymbolType } | null {
  // Capitals are matched so a camelCase flag is seen whole and rejected by the
  // grammar, not truncated at its first capital. cli-reference.md writes the pair
  // as `--allowedTools`, `--allowed-tools`; a `/--[a-z][a-z0-9-]+/` match stops at
  // the `T` and yields the phantom `--allowed`, which shipped with the real flag's
  // description. Same defect the binary lane carried (see extract-bundle FLAG_TOKEN).
  for (const token of inner.match(/--[A-Za-z][A-Za-z0-9-]*/g) ?? []) {
    if (/^--[a-z][a-z0-9-]+$/.test(token)) return { symbol: token, type: 'cli_flag' };
  }

  // A slash command names the WHOLE cell (`/compact`, optionally `/compact <arg>`)
  // — anchored at the start. An embedded slash in a path or capability name
  // (`claude/channel`, `commands/foo`, `tools/src`) has a leading segment before
  // the `/`, so it is prose about channels/plugins/tools, not a command.
  const command = inner.match(/^(\/[a-z][a-z0-9-]+)/);
  if (command?.[1]) return { symbol: command[1], type: 'command' };

  const env = inner.match(/\b([A-Z][A-Z0-9_]{3,})\b/);
  if (env?.[1] && !ENV_DENYLIST.has(env[1])) return { symbol: env[1], type: 'env_var' };

  return null;
}

export function symbolFromCell(cell: string): { symbol: string; type: DocSymbolType } | null {
  return symbolsFromCell(cell)[0] ?? null;
}

/**
 * The trackable symbol(s) named by a table's first cell. Usually one — but a cell
 * that lists an alias/pair of the SAME type joined only by separators (a slash or
 * comma), e.g. `` `--sandbox` / `--no-sandbox` ``, names every one of them. Prose
 * BETWEEN the spans (`` `--model` overrides `ANTHROPIC_MODEL` ``) means the cell's
 * subject is just the first span, so only that one is returned.
 */
export function symbolsFromCell(cell: string): Array<{ symbol: string; type: DocSymbolType }> {
  // Group 1 is always present when the pattern matches, so the cast is safe.
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map((m) => (m[1] as string).trim());
  const resolved = spans.map((span) => symbolFromInner(span));
  // The subject is the first span that names a symbol, not necessarily span 0: an
  // alias cell can LEAD with an out-of-grammar spelling (`--allowedTools`,
  // `--allowed-tools`), and anchoring on span 0 would drop the whole row — losing
  // the valid alias along with the rejected one.
  const firstIndex = resolved.findIndex((sym) => sym !== null);
  const first = firstIndex === -1 ? null : (resolved[firstIndex] ?? null);
  if (!first) return [];

  // Multi-emit only for an alias/pair cell: >1 span and the text outside every
  // span is nothing but separators/whitespace. Anything else (prose) → primary only.
  const outsideSpans = cell.replace(/`[^`]+`/g, '').trim();
  if (spans.length === 1 || !/^[\s/,]*$/.test(outsideSpans)) return [first];

  const out = [first];
  const seen = new Set([`${first.type}:${first.symbol}`]);
  for (const sym of resolved.slice(firstIndex + 1)) {
    if (sym && sym.type === first.type && !seen.has(`${sym.type}:${sym.symbol}`)) {
      seen.add(`${sym.type}:${sym.symbol}`);
      out.push(sym);
    }
  }
  return out;
}

/**
 * Parse one page's markdown tables into doc entries. A row is a `| … | … |`
 * line (not a `|:---|` separator) whose first cell names a symbol; the second
 * cell is its description.
 */
/**
 * Splits a Markdown table row into cells on the pipes that are real column
 * delimiters — a `|` counts only when it is neither escaped (`\|`) nor inside an
 * inline-code span (between backticks). So a cell like `` `model|fallback` `` or
 * `a \| b` stays whole instead of being truncated at the pipe. Escaped pipes are
 * unescaped to a literal `|` in the returned cells.
 */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      current += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Settings-page sections that define config keys, with the namespace each table's
 * bare keys sit under and, where the page distinguishes one, the category. An
 * ALLOWLIST: a section absent from this map contributes nothing, so a new upstream
 * heading cannot silently start publishing keys.
 *
 * Excluded on purpose, each on the page's own evidence:
 *  - "Permission rule syntax" — its first column holds rules (`Bash`), not keys.
 *  - "Invalid entries in managed settings" — a behaviour-when-invalid table; its
 *    descriptions describe error handling, not what the key does.
 *  - "Plugin settings" — prose and a plugin-component table, no key definitions.
 */
interface SettingsSection {
  /** Namespace the table's bare keys sit under; empty when they are top-level. */
  namespace: string;
  /**
   * Overrides the categorizer for this section's keys. Only "Global config
   * settings" needs it: those keys are real config keys, but they live in
   * `~/.claude.json` and the page says Claude Code "silently ignores them" in
   * `settings.json`. Publishing them as ordinary `settings` would assert exactly
   * what the page denies, and dropping them would lose documented surface — so
   * they publish under their own category instead.
   */
  category?: string;
}

const SETTINGS_SECTIONS: ReadonlyMap<string, SettingsSection> = new Map([
  ['Available settings', { namespace: '' }],
  ['Worktree settings', { namespace: '' }], // rows already fully qualified (`worktree.baseRef`)
  ['Global config settings', { namespace: '', category: 'global-config' }],
  ['Permission settings', { namespace: 'permissions' }],
  ['Sandbox settings', { namespace: 'sandbox' }],
  ['Attribution settings', { namespace: 'attribution' }],
  ['Compute managed settings with a policy helper', { namespace: 'policyHelper' }],
]);

/**
 * A settings row's first cell: exactly one backticked key and nothing else, every
 * dot-segment starting lowercase or `$` — `advisorModel`,
 * `sandbox.filesystem.allowWrite`, `$schema`.
 *
 * That leading-lowercase rule is what keeps an env var out. These tables mention
 * `CLAUDE_CODE_SAFE_MODE` and friends in passing, and a shape-agnostic pattern
 * publishes them as config keys — the same name would then exist under two types.
 * Flags are excluded by the same rule, since they lead with a dash.
 */
const SETTINGS_KEY_CELL = /^`((?:[$a-z][A-Za-z0-9_$]*)(?:\.[$a-z][A-Za-z0-9_$]*)*)`$/;

/**
 * The real schema path for a settings row.
 *
 * The page's tables group by TOPIC, not by JSON nesting, so a namespaced section
 * can still list a top-level key: `skipDangerousModePermissionPrompt` sits under
 * "Permission settings" while the schema has it flat, next to
 * `showThinkingSummaries`. Prefixing blindly would publish a path that does not
 * exist, which is the whole failure this resolution exists to avoid — so the
 * binary-derived schema decides, and the page only supplies the description.
 *
 * Note the prefix test is "already rooted at this namespace", NOT "contains a
 * dot": Sandbox rows use sub-namespaces (`filesystem.allowWrite`) that are still
 * `sandbox.`-rooted, and treating a dot as already-qualified strands them.
 */
function resolveSettingsPath(
  raw: string,
  namespace: string,
  section: string,
  known: ReadonlySet<string> | undefined
): string {
  if (!namespace || raw === namespace || raw.startsWith(`${namespace}.`)) return raw;
  if (!known) {
    throw new Error(
      `settings docs: section "${section}" needs the settings schema to resolve ` +
        `"${raw}", but no known-key set was supplied. Refusing to guess a key path.`
    );
  }
  const qualified = `${namespace}.${raw}`;
  if (known.has(qualified)) return qualified;
  if (known.has(raw)) return raw;
  throw new Error(
    `settings docs: "${raw}" under "${section}" matches neither "${qualified}" nor ` +
      `a top-level key. The page's grouping changed; refusing to publish a guessed path.`
  );
}

/**
 * Config keys from the settings page. Deliberately the ONLY thing read from it:
 * the page also discusses env vars, but `env-vars.md` is their authoritative page
 * and is already scraped, so re-reading them here could only add duplicates or
 * phantoms.
 */
function parseSettingsPage(
  page: string,
  markdown: string,
  known: ReadonlySet<string> | undefined
): DocEntry[] {
  const entries: DocEntry[] = [];
  let section = '';
  // Which column holds the description. Not always the second: the policy-helper
  // table is `| Key | Type | Description |`, and assuming column 1 published
  // "string" as `policyHelper.path`'s description. Read each table's own header.
  let descColumn = 1;
  for (const line of markdown.split('\n')) {
    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    if (heading) {
      section = (heading[1] as string).trim();
      descColumn = 1;
      continue;
    }
    const spec = SETTINGS_SECTIONS.get(section);
    if (spec === undefined) continue;
    if (!/^\s*\|/.test(line) || /^\s*\|\s*:?-{2,}/.test(line)) continue;
    const cells = splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const headerAt = cells.findIndex((c) => /^description$/i.test(c));
    if (headerAt > 0) {
      descColumn = headerAt;
      continue; // this row IS the header
    }
    const keyCell = cells[0] as string;
    const descCell = (cells[descColumn] ?? cells[1]) as string;
    const matched = SETTINGS_KEY_CELL.exec(keyCell);
    if (!matched) continue;
    const description = cleanCell(descCell);
    if (description.length < 3) continue;
    entries.push({
      symbol: resolveSettingsPath(matched[1] as string, spec.namespace, section, known),
      type: 'config_key',
      description,
      doc_min_version: minVersion(descCell) ?? minVersion(keyCell),
      doc_page: page,
      ...(spec.category ? { category: spec.category } : {}),
    });
  }
  return entries;
}

export function parseDocPage(
  page: string,
  markdown: string,
  knownConfigKeys?: ReadonlySet<string>
): DocEntry[] {
  if (page === 'settings') return parseSettingsPage(page, markdown, knownConfigKeys);
  const entries: DocEntry[] = [];
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|\s*:?-{2,}/.test(line)) continue;
    const cells = splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    // length >= 2 guarantees both are present, so the casts are safe.
    const symbolCell = cells[0] as string;
    const descCell = cells[1] as string;

    const syms = symbolsFromCell(symbolCell);
    if (syms.length === 0) continue;
    const description = cleanCell(descCell);
    if (description.length < 3) continue;

    // Only a cell-level marker (either column) here — never the page baseline. The
    // baseline is applied page-locally in buildDocsIndex AFTER dedupe, so it can't
    // ride the cross-page min-version backfill onto an earlier page's dateless flag
    // (e.g. remote-control's 2.1.51 must not stamp cli-reference's `--verbose`).
    const doc_min_version = minVersion(descCell) ?? minVersion(symbolCell);
    for (const sym of syms) {
      entries.push({ symbol: sym.symbol, type: sym.type, description, doc_min_version, doc_page: page });
    }
  }
  return entries;
}

/** Merge per-page entries, first definition wins, sorted by type then symbol. */
export function buildDocsIndex(
  pages: Array<{ page: string; markdown: string }>,
  knownConfigKeys?: ReadonlySet<string>
): DocsIndex {
  const seen = new Map<string, DocEntry>();
  for (const { page, markdown } of pages) {
    // A baselined page is SUPPLEMENTAL: it documents subcommand-scoped flags, so a
    // name that collides with an earlier page is usually a DIFFERENT flag (e.g.
    // remote-control's `--session-id` @2.1.200 vs the top-level `--session-id`
    // @1.0.53). It may only CONTRIBUTE net-new symbols — never backfill or override
    // a symbol an earlier (primary) page already owns. Its net-new symbols inherit
    // the page baseline when they carry no cell-level marker.
    const baseline = PAGE_BASELINE_MIN_VERSION[page as (typeof DOC_PAGES)[number]];
    const supplemental = baseline !== undefined;
    for (const entry of parseDocPage(page, markdown, knownConfigKeys)) {
      const key = `${entry.type}:${entry.symbol}`;
      const existing = seen.get(key);
      if (!existing) {
        if (supplemental && !entry.doc_min_version) entry.doc_min_version = baseline;
        seen.set(key, entry);
      } else if (!supplemental && !existing.doc_min_version && entry.doc_min_version) {
        // Normal cross-page backfill, among primary pages only: a later primary
        // page fills a min-version the winning page lacked.
        existing.doc_min_version = entry.doc_min_version;
      }
    }
  }
  const symbols = [...seen.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.symbol.localeCompare(b.symbol)
  );
  return {
    $generated_by: 'scripts/fetch-docs.ts',
    source_pages: DOC_PAGES.map((p) => `${DOCS_BASE}${p}.md`),
    symbols,
  };
}

/** The official docs page slugs. A `doc_page` outside this set is not first-party. */
export const OFFICIAL_DOC_PAGES: ReadonlySet<string> = new Set(DOC_PAGES);

/** The exact `source_pages` a fetch-docs-produced index carries. */
export function officialSourcePages(): string[] {
  return DOC_PAGES.map((p) => `${DOCS_BASE}${p}.md`);
}

/**
 * Integrity guard for the committed docs index: its `source_pages` must be
 * exactly the official Claude Code docs URLs and every `doc_page` must be an
 * official page slug. Catches a hand-edited or corrupted `data/docs.json`
 * before its entries are published as `provenance: "docs"` with real-looking
 * `code.claude.com/docs` source URLs.
 */
export function assertOfficialDocs(docs: DocsIndex): void {
  const expected = officialSourcePages();
  const sourcesMatch =
    docs.source_pages.length === expected.length &&
    expected.every((url, i) => docs.source_pages[i] === url);
  if (!sourcesMatch) {
    throw new Error(
      'Docs index source_pages do not match the official Claude Code documentation pages ' +
        '(code.claude.com/docs); refusing to publish it as provenance:"docs". ' +
        'Regenerate with "npm run fetch-docs".'
    );
  }
  for (const entry of docs.symbols) {
    if (!OFFICIAL_DOC_PAGES.has(entry.doc_page)) {
      throw new Error(
        `Docs entry ${entry.symbol} references a non-official doc_page "${entry.doc_page}".`
      );
    }
  }
}

async function fetchPage(page: string): Promise<{ page: string; markdown: string }> {
  const url = `${DOCS_BASE}${page}.md`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return { page, markdown: await response.text() };
}

/**
 * The settings-key paths the binary lane has ever observed, from the committed
 * `data/binary-observations.json`. This is the authority for what a settings
 * PATH is; the docs page is the authority for what it MEANS.
 *
 * A cross-lane read, and a deliberate one: the alternative is a hand-maintained
 * list of the page's topic-grouped rows, which would rot silently the next time
 * Anthropic regroups a table. Reading the committed artifact makes the namespace
 * claim checkable instead of assumed. Missing or unreadable is fatal rather than
 * skipped — running without it would publish guessed key paths.
 */
export async function knownSettingsKeys(path: string): Promise<ReadonlySet<string>> {
  const raw = JSON.parse(await readFile(path, 'utf-8')) as {
    symbols?: Array<{ type?: string; symbol?: string }>;
  };
  const keys = new Set<string>();
  for (const observation of raw.symbols ?? []) {
    if (observation.type === 'config_key' && observation.symbol) keys.add(observation.symbol);
  }
  if (keys.size === 0) {
    throw new Error(
      `${path} holds no config_key observations; refusing to resolve settings-page ` +
        `key paths against an empty schema.`
    );
  }
  return keys;
}

export async function main(argv: string[]): Promise<void> {
  const outPath = argv[0] ?? 'data/docs.json';
  const known = await knownSettingsKeys(argv[1] ?? 'data/binary-observations.json');
  const pages = await Promise.all(DOC_PAGES.map(fetchPage));
  const index = buildDocsIndex(pages, known);
  await writeFile(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  const withMin = index.symbols.filter((s) => s.doc_min_version).length;
  console.log(
    `Wrote ${outPath}: ${index.symbols.length} documented symbols (${withMin} with a min-version).`
  );
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
