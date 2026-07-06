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
import { writeFile } from 'node:fs/promises';
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
] as const;

export type DocSymbolType = 'cli_flag' | 'command' | 'env_var';

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
]);

export interface DocEntry {
  symbol: string;
  type: DocSymbolType;
  description: string;
  doc_min_version: string | null;
  doc_page: string;
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
export function symbolFromCell(cell: string): { symbol: string; type: DocSymbolType } | null {
  const backtick = cell.match(/`([^`]+)`/);
  if (!backtick) return null;
  const inner = backtick[1] ?? '';

  const flag = inner.match(/(--[a-z][a-z0-9-]+)/);
  if (flag?.[1]) return { symbol: flag[1], type: 'cli_flag' };

  const command = inner.match(/(\/[a-z][a-z0-9-]+)/);
  if (command?.[1]) return { symbol: command[1], type: 'command' };

  const env = inner.match(/\b([A-Z][A-Z0-9_]{3,})\b/);
  if (env?.[1] && !ENV_DENYLIST.has(env[1])) return { symbol: env[1], type: 'env_var' };

  return null;
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

export function parseDocPage(page: string, markdown: string): DocEntry[] {
  const entries: DocEntry[] = [];
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|\s*:?-{2,}/.test(line)) continue;
    const cells = splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;

    const sym = symbolFromCell(cells[0] ?? '');
    if (!sym) continue;
    const description = cleanCell(cells[1] ?? '');
    if (description.length < 3) continue;

    entries.push({
      symbol: sym.symbol,
      type: sym.type,
      description,
      doc_min_version: minVersion(cells[1] ?? '') ?? minVersion(cells[0] ?? ''),
      doc_page: page,
    });
  }
  return entries;
}

/** Merge per-page entries, first definition wins, sorted by type then symbol. */
export function buildDocsIndex(pages: Array<{ page: string; markdown: string }>): DocsIndex {
  const seen = new Map<string, DocEntry>();
  for (const { page, markdown } of pages) {
    for (const entry of parseDocPage(page, markdown)) {
      const key = `${entry.type}:${entry.symbol}`;
      const existing = seen.get(key);
      // First page wins; but let a later page fill in a missing min-version.
      if (!existing) {
        seen.set(key, entry);
      } else if (!existing.doc_min_version && entry.doc_min_version) {
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

export async function main(argv: string[]): Promise<void> {
  const outPath = argv[0] ?? 'data/docs.json';
  const pages = await Promise.all(DOC_PAGES.map(fetchPage));
  const index = buildDocsIndex(pages);
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
