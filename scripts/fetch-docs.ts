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
import { runCli } from './lib.js';

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
  // The old `plugins-reference` page split in two. Its URL now redirects to the
  // manifest page, which kept only the plugin env vars; the `claude plugin`
  // subcommand flag tables moved to the plugin commands reference.
  'plugins/cli-reference',
  'plugins/manifest-reference',
  'channels-reference',
  'glossary',
  'remote-control',
  'settings',
  'settings-reference',
  'plugins/mods/reference',
  'self-hosted-environments-reference',
  'monitoring-usage',
  'plugin-evals',
  'ultrareview',
] as const;

export type DocSymbolType =
  | 'cli_flag'
  | 'command'
  | 'env_var'
  | 'config_key'
  | 'mod_method'
  | 'mod_event'
  | 'mod_render_site'
  | 'mod_element';

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

/**
 * The least a symbol-bearing page may contribute before the run is treated as a
 * parse failure rather than an upstream deletion.
 *
 * Anthropic moved the settings tables to their own page. The settings page still
 * fetched, still parsed, and yielded nothing — so every documented settings key
 * lost its description, fell back to the binary lane, and landed at
 * `needs_review`. A green run reported that as fact. Nothing in the pipeline can
 * tell "the page stopped saying it" from "we stopped reading it", so the page set
 * has to state what it expects to find.
 *
 * A page absent from this map contributes optionally: several official pages are
 * fetched for prose context and name no trackable symbol at all. Each floor is
 * set near half the page's present yield — low enough that ordinary churn never
 * trips it, high enough that a collapse cannot pass — or at one where the page is
 * a small supplement. When a floor does fire, read the page before lowering it.
 */
export const PAGE_MIN_SYMBOLS: Partial<Record<(typeof DOC_PAGES)[number], number>> = {
  'cli-reference': 50,
  commands: 60,
  'env-vars': 200,
  'settings-reference': 120,
  'plugins/cli-reference': 10,
  'plugins/manifest-reference': 2,
  'remote-control': 1,
  'plugins/mods/reference': 40,
  'self-hosted-environments-reference': 25,
  'monitoring-usage': 10,
  'plugin-evals': 2,
  ultrareview: 1,
};

/**
 * Floors per symbol TYPE, for a type that shares a page with a larger one. The mods
 * reference page holds both its method table and its event tables, and the method
 * rows alone clear that page's floor, so an emptied Events section would pass it.
 * Set near half the present yield, as the page floors are.
 */
export const TYPE_MIN_SYMBOLS: Partial<Record<DocSymbolType, number>> = {
  mod_method: 40,
  mod_event: 20,
  mod_render_site: 8,
  mod_element: 6,
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

/**
 * Backticked `/word` spans a doc table uses as a path placeholder, not a slash
 * command. `/path` comes from the plugin commands reference's marketplace source
 * table (`` `./path`, `../path`, `/path`, or `~/path` to a directory ``), where
 * it is the first span that matches the command pattern.
 */
const COMMAND_DENYLIST = new Set(['/path']);

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
  /**
   * The subcommand heading this row sat under, e.g. "plugin init" — the raw
   * scope candidate. Internal to parsing only: `buildDocsIndex` uses it to build
   * `scope_descriptions` and then strips it, so it never reaches `docs.json`.
   */
  scope?: string;
  /**
   * Per-scope description overrides for a flag the docs describe differently
   * under different subcommands (e.g. `--force` under `plugin init` vs `plugin
   * tag`). Keys are subcommand headings; values are the description under each.
   * Set only when a flag appears under >1 heading with genuinely different text;
   * the top-level `description` stays the first-seen (primary) one.
   */
  scope_descriptions?: Record<string, string>;
  /**
   * The subcommands the primary `description` was documented under, for an entry
   * from a page whose sections SECTION_SCOPES ties to subcommands. The scrape lane
   * keeps that text as the primary only while it covers every binary-proved scope
   * of the flag; otherwise it moves the text to `scope_descriptions` for these
   * scopes, so no record claims a meaning the docs gave for another subcommand.
   */
  doc_scopes?: string[];
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
 * The trackable symbol named by ONE backtick span, or null. Tests in order: a
 * `/command` anchored at the start, then a `--flag`, then an `ALL_CAPS`
 * environment variable. Skips `claude sub command` rows and prose.
 *
 * The order is load-bearing and is the whole point of the anchor test below —
 * scanning for a flag first took `--force` out of `` `/reload-plugins [--force]` ``
 * and lost the command. The caller (`symbolsFromCell`) tries every span and takes
 * the first that resolves, so this is not necessarily the cell's first span.
 */
function symbolFromInner(inner: string): { symbol: string; type: DocSymbolType } | null {
  // A slash command names the WHOLE cell (`/compact`, optionally `/compact <arg>`)
  // — anchored at the start. An embedded slash in a path or capability name
  // (`claude/channel`, `commands/foo`, `tools/src`) has a leading segment before
  // the `/`, so it is prose about channels/plugins/tools, not a command.
  //
  // Tested BEFORE the flag scan, because the commands page writes a command's
  // arguments into the same span: `` `/reload-plugins [--force]` ``. Scanning for
  // a flag first took `--force` as the row's subject, which both lost the
  // `/reload-plugins` command AND published `--force` as a top-level CLI flag
  // carrying the *command's* description ("Reload all active plugins to apply
  // pending changes without restarting…"). Same for `/code-review … [--fix] …`
  // and `/import [codex|gemini] [--dry-run] [--yes]`. A bracketed argument of a
  // slash command is not a `claude` CLI flag; the anchor is what tells them apart.
  const command = inner.match(/^(\/[a-z][a-z0-9-]+)/);
  if (command?.[1]) {
    return COMMAND_DENYLIST.has(command[1]) ? null : { symbol: command[1], type: 'command' };
  }

  // Capitals are matched so a camelCase flag is seen whole and rejected by the
  // grammar, not truncated at its first capital. cli-reference.md writes the pair
  // as `--allowedTools`, `--allowed-tools`; a `/--[a-z][a-z0-9-]+/` match stops at
  // the `T` and yields the phantom `--allowed`, which shipped with the real flag's
  // description. Same defect the binary lane carried (see extract-bundle FLAG_TOKEN).
  for (const token of inner.match(/--[A-Za-z][A-Za-z0-9-]*/g) ?? []) {
    if (/^--[a-z][a-z0-9-]+$/.test(token)) return { symbol: token, type: 'cli_flag' };
  }

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
  // findIndex just proved resolved[firstIndex] is non-null.
  const first = firstIndex === -1 ? null : resolved[firstIndex]!;
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

/**
 * Topic sections of the settings-reference page that define config keys, with the
 * category where the page distinguishes one. An ALLOWLIST, for the same reason
 * `SETTINGS_SECTIONS` is one: a heading absent from this map contributes nothing,
 * so a new upstream section cannot silently start publishing keys.
 *
 * Excluded on purpose:
 *  - "All settings" — the index table. Every row links to the entry below it, so
 *    reading both would parse each key twice, and the index cell is a one-line
 *    summary while the entry carries the prose AND the version marker.
 *  - "See also" — a link list, no key definitions.
 */
const SETTINGS_REFERENCE_SECTIONS: ReadonlyMap<string, { category?: string }> = new Map([
  ['Model and responses', {}],
  ['Permission settings', {}],
  ['Sandbox settings', {}],
  ['Memory and context', {}],
  ['Interface and terminal', {}],
  ['Git and attribution', {}],
  ['Hooks and automation', {}],
  ['Plugins and skills', {}],
  ['MCP', {}],
  ['Agents, sessions, and worktrees', {}],
  ['Remote, desktop, and notifications', {}],
  ['Authentication and providers', {}],
  ['Updates and versioning', {}],
  ['Tools', {}],
  ['Privacy and telemetry', {}],
  ['Enterprise and managed settings', {}],
  // Same reasoning as the settings page's section of this name: real config keys
  // that live in `~/.claude.json`, not `settings.json`.
  ['Global config settings', { category: 'global-config' }],
]);

/** An entry heading on the settings-reference page: `### \`sandbox.network.allow\``. */
const SETTINGS_ENTRY_HEADING = /^###\s+(.*)$/;

/**
 * A Mintlify component tag alone on its line (`<Warning>`, `</Note>`). Dropped so a
 * callout-first entry yields its text instead of the tag: a deprecation notice IS
 * the description for a key whose entry opens with one. Only a whole-line tag is
 * removed, so a `<placeholder>` inside prose survives.
 */
const COMPONENT_TAG_LINE = /^\s*<\/?[A-Z][A-Za-z]*(\s[^>]*)?\/?>\s*$/;

/**
 * Config keys from the settings-reference page, which defines one key per `###`
 * entry under a topic `##` heading rather than in tables.
 *
 * Entry headings carry the FULL key path (`sandbox.credentials.envVars`), so this
 * page needs none of the namespace resolution `parseSettingsPage` does — there is
 * no bare key to qualify and so nothing to guess.
 *
 * The description AND the version marker both come from the entry's opening
 * paragraph, never from the rest of the entry. An entry documents its key's
 * sub-options too, and those carry their own `Requires Claude Code vX.Y.Z`
 * sentences: `extraKnownMarketplaces` states one for the `skipLfs` field of its
 * source objects, which the binary lane dates many releases after the key itself.
 * Reading the whole entry would publish that as the key's introduction. The old
 * settings page confined the marker to the key's own table row; the opening
 * paragraph is this page's equivalent of that row.
 */
function parseSettingsReferencePage(page: string, markdown: string): DocEntry[] {
  const entries: DocEntry[] = [];
  const lines = markdown.split('\n');
  let section = '';
  let current: { symbol: string; category?: string; body: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const { symbol, category, body } = current;
    current = null;
    const kept = body.filter((line) => !COMPONENT_TAG_LINE.test(line));
    let i = 0;
    while (i < kept.length && (kept[i] as string).trim() === '') i++;
    const paragraph: string[] = [];
    while (i < kept.length && (kept[i] as string).trim() !== '') {
      paragraph.push(kept[i] as string);
      i++;
    }
    const opening = paragraph.join(' ');
    const description = cleanCell(opening);
    if (description.length < 3) return;
    entries.push({
      symbol,
      type: 'config_key',
      description,
      doc_min_version: minVersion(opening),
      doc_page: page,
      ...(category ? { category } : {}),
    });
  };

  for (const line of lines) {
    const topic = /^##\s+([^#].*)$/.exec(line);
    if (topic) {
      flush();
      section = (topic[1] as string).trim();
      continue;
    }
    const entry = SETTINGS_ENTRY_HEADING.exec(line);
    if (entry) {
      flush();
      const spec = SETTINGS_REFERENCE_SECTIONS.get(section);
      const heading = (entry[1] as string).trim();
      if (spec === undefined) continue;
      const matched = SETTINGS_KEY_CELL.exec(heading);
      if (matched) {
        current = { symbol: matched[1] as string, ...spec, body: [] };
        continue;
      }
      // A prose subheading ("Examples") is not a key and is simply skipped. A
      // BACKTICKED heading that fails the key grammar is a construct this parser
      // does not understand — an env var or a flag given its own entry, say — and
      // skipping it silently would read downstream as a key that never existed.
      if (/^`[^`]+`$/.test(heading)) {
        throw new Error(
          `settings-reference: entry heading ${heading} under "${section}" is not a ` +
            `settings key path. The page's entry grammar changed; refusing to guess.`
        );
      }
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return entries;
}

/**
 * Normalises a subcommand heading ("### plugin init", "### `claude plugin tag`")
 * to the scope string a record carries — a FULL invocation path after `claude`,
 * so "plugin init", "plugin tag". Returns undefined for an empty heading. Whether
 * the result is a REAL scope is decided later by intersecting with the record's
 * binary-proved scopes (in scrape-changelog's withScopes), so a non-subcommand
 * heading here ("Flags", "Overview") is harmless — it simply matches nothing.
 */
function scopeFromHeading(raw: string): string | undefined {
  const cleaned = raw
    .replace(/`/g, '')
    .replace(/^claude\s+/i, '')
    .trim();
  // A real subcommand scope is a path of lowercase command tokens ("plugin tag",
  // "mcp add-json"). Prose section headings ("CLI flags", "System prompt flags",
  // "Start a Remote Control session") carry capitals or articles and are NOT
  // scopes — reject them here so they never reach the published docs.json. This
  // only trims obvious noise; the authoritative filter is still the intersection
  // with binary-proved scopes in scrape-changelog's withScopes.
  return /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(cleaned) ? cleaned : undefined;
}

/**
 * Pages whose symbol definitions sit under known headings, with those headings. An
 * ALLOWLIST, as `SETTINGS_SECTIONS` is one: a section absent from a listed page's
 * set contributes nothing, so a new upstream table cannot silently start
 * publishing symbols. A page absent from this map reads every table.
 *
 * env-vars excludes, on the page's own evidence:
 *  - "What the subprocess environment scrub removes" — an EXAMPLE table. Its rows
 *    name variables Claude Code strips from or leaves in a child environment
 *    (`NPM_TOKEN`, `GH_TOKEN`, `GIT_CONFIG_KEY_<n>`), not variables it reads, and
 *    its second column says what the scrub does, not what the variable does. Its
 *    `CLAUDE_CONFIG_DIR` row also carries a "Requires v2.1.251" marker that dates
 *    the scrub behaviour, which the min-version backfill stamped on the variable.
 *
 * `PAGE_MIN_SYMBOLS` is the guard on the other side: a renamed heading empties the
 * page and trips its floor instead of reading as a mass removal.
 */
const PAGE_SYMBOL_SECTIONS: Partial<Record<string, ReadonlySet<string>>> = {
  'env-vars': new Set(['Variables']),
  // The flag and env-var tables only; the Prometheus metrics tables name series.
  'self-hosted-environments-reference': new Set([
    'Runner CLI flags',
    'Orchestrator CLI flags',
    'SCM connector flags',
    'Environment-variable-only settings',
  ]),
  // The env-var tables only; the attribute, metric and event tables define nothing.
  'monitoring-usage': new Set([
    'Common configuration variables',
    'Metrics cardinality control',
    'Traces (beta)',
  ]),
  'plugin-evals': new Set(['Command options']),
  ultrareview: new Set(['Run ultrareview non-interactively']),
};

/**
 * Pages whose flag sections each belong to one subcommand, though their headings
 * are prose ("Runner CLI flags") that scopeFromHeading rightly rejects. The scope
 * is the full invocation path after `claude`, as a record carries it. An entry from
 * such a section records the scope its description was documented under, and the
 * winner of a key gets `doc_scopes` (see DocEntry).
 */
const SECTION_SCOPES: Partial<Record<string, Readonly<Record<string, string>>>> = {
  'self-hosted-environments-reference': {
    'Runner CLI flags': 'self-hosted-runner',
    'Orchestrator CLI flags': 'self-hosted-runner orchestrator',
    'SCM connector flags': 'self-hosted-runner orchestrator',
  },
  'plugin-evals': { 'Command options': 'plugin eval' },
  // The server flags table. Without it, `--capacity` keeps this page's text as the
  // primary for `self-hosted-runner` too, where the default is 1, not 32.
  'remote-control': { 'Start a Remote Control session': 'remote-control' },
  ultrareview: { 'Run ultrareview non-interactively': 'ultrareview' },
};

/**
 * Flags a page documents once and then says another subcommand accepts with the
 * same defaults, read here as the same flag with the same meaning. The self-hosted
 * reference says, under "Orchestrator CLI flags":
 * "The `self-hosted-runner orchestrator` subcommand … accepts `--api-url`,
 * `--environment-secret-file`, `--hooks-dir`, `--health-port`, and `--log-level`
 * with the same defaults as the runner". Each flag then carries its runner text for
 * the orchestrator scope too. parseDocPage refuses the page if that paragraph no
 * longer names every flag, so the list cannot silently go stale.
 */
const SCOPE_INHERITANCE: Partial<
  Record<string, { section: string; from: string; to: string; flags: readonly string[] }>
> = {
  'self-hosted-environments-reference': {
    section: 'Orchestrator CLI flags',
    from: 'self-hosted-runner',
    to: 'self-hosted-runner orchestrator',
    flags: [
      '--api-url',
      '--environment-secret-file',
      '--hooks-dir',
      '--health-port',
      '--log-level',
    ],
  },
};

/**
 * The column of a table that holds the description, read from its header row. Most
 * tables put it second, but the self-hosted reference writes `Flag | Env var |
 * Default | Description` and plugin-evals writes `Option | Default | Effect`, so the
 * second column there is a variable name or a default value.
 */
function descriptionColumn(header: readonly string[]): number {
  const named = header.findIndex((cell) => DESCRIPTION_HEADER.test(cell));
  return named > 0 ? named : 1;
}

const DESCRIPTION_HEADER = /^(?:description|effect)$/i;

/**
 * The column that names the env var setting the same value as the row's flag, or
 * -1. The self-hosted runner table writes `Flag | Env var | Default | Description`,
 * and each variable there is documented by its flag's row.
 */
function envVarColumn(header: readonly string[]): number {
  const named = header.findIndex((cell) => /^env(?:ironment)? var(?:iable)?$/i.test(cell));
  return named > 0 ? named : -1;
}

/**
 * Throws when an allowlisted table cannot be read by column. A header wider than
 * two cells must name its description column, or descriptionColumn would fall
 * back to the second cell and publish an env-var name or a default as the text.
 * A stray line inside a table makes the next data row look like a header, so it
 * fails here too. A row shorter than its header would read the wrong cell.
 */
function assertReadableRow(
  page: string,
  section: string,
  cells: readonly string[],
  header: readonly string[],
  isHeader: boolean
): void {
  if (
    isHeader &&
    header.length > 2 &&
    !DESCRIPTION_HEADER.test(header[descriptionColumn(header)] as string)
  ) {
    throw new Error(
      `Docs page "${page}": a table in "${section}" has the header | ${header.join(' | ')} |, ` +
        'which names no Description or Effect column. Read the page and update descriptionColumn.'
    );
  }
  if (cells.length < header.length) {
    throw new Error(
      `Docs page "${page}": a row in "${section}" has ${cells.length} cells under a ` +
        `${header.length}-cell header: | ${cells.join(' | ')} |`
    );
  }
}

/**
 * The "Mods API methods" table of the mods reference page. Each row names a
 * namespace (`` `$.ui` ``, sometimes as a link) and lists its methods in backticks,
 * often followed by notes that backtick other words: `$.agent` lists status values,
 * and `$.state` names helper functions. So only the LEADING run of backticked words
 * (optionally written as calls) joined by commas, "and" or "or" is read, which is
 * the method list on every row.
 *
 * No row dates a method: a version in a note (`$.agent`'s v2.1.289) dates the note.
 * The rows carry no per-method description either, so the description is empty and
 * the binary lane dates the record.
 */
function parseModsReferencePage(page: string, markdown: string): DocEntry[] {
  const entries: DocEntry[] = [];
  let inSection = false;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      inSection = (heading[1] as string).trim() === 'Mods API methods';
      continue;
    }
    if (!inSection || !/^\s*\|/.test(line) || /^\s*\|\s*:?-{1,}/.test(line)) continue;
    const [namespaceCell, methodsCell] = splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());
    if (namespaceCell === 'Namespace') continue; // the header row
    const namespace = /`\$\.([a-z][a-zA-Z0-9]*)`/.exec(namespaceCell ?? '')?.[1];
    const run =
      /^[^`]*((?:`[a-z][a-zA-Z0-9]*(?:\(\))?`(?:,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)?)+)/.exec(
        methodsCell ?? ''
      );
    const leading = run?.[1];
    // A list that stops at a backtick stopped at a name it cannot read, so the rest
    // of the list would be lost; the notes after a whole list start with prose.
    const cutShort = run !== null && run.input.slice(run[0].length).startsWith('`');
    // Every row of this table names methods, so a row this cannot read is a parser
    // gap, not an empty row. The page floor only catches a large loss.
    if (namespace === undefined || leading === undefined || cutShort) {
      throw new Error(
        `Docs page "${page}": a row of the "Mods API methods" table has no readable ` +
          `namespace or method list: ${line.trim()}. Read the page and fix ` +
          'parseModsReferencePage.'
      );
    }
    for (const match of leading.matchAll(/`([a-z][a-zA-Z0-9]*)(?:\(\))?`/g)) {
      entries.push({
        symbol: `$.${namespace}.${match[1] as string}`,
        type: 'mod_method',
        description: '',
        doc_min_version: null,
        doc_page: page,
      });
    }
  }
  return [
    ...entries,
    ...parseModsEventTables(page, markdown),
    ...parseModsRenderSiteTable(page, markdown),
    ...parseModsElementTable(page, markdown),
  ];
}

/**
 * The "Render sites" table of the mods reference page. Its first cell names one site
 * or more in backticks (`` `ToolUse`, `ToolResult`, `ToolGroup` ``, sometimes as a
 * link), and nothing else. The other cells list props and apps, not what the site is,
 * so the record carries no description and the binary lane dates it. The section holds
 * one table, headed "Site". A second table, any other header, and a first cell holding
 * anything but site names stop the run. Fenced code is skipped, so an example cannot
 * open the section.
 */
function parseModsRenderSiteTable(page: string, markdown: string): DocEntry[] {
  const entries: DocEntry[] = [];
  const refuse = (what: string, line: string): never => {
    throw new Error(
      `Docs page "${page}": ${what}: ${line.trim()}. Read the page and fix ` +
        'parseModsRenderSiteTable.'
    );
  };
  // A site name written plainly or as a link, several to a cell, joined by commas.
  const name = String.raw`(?:\[\`[A-Z][A-Za-z]*\`\]\([^)\s]*\)|\`[A-Z][A-Za-z]*\`)`;
  const cellOfNames = new RegExp(`^${name}(?:,\\s*${name})*$`);
  let inSection = false;
  let inFence = false;
  let tables = 0;
  let inTable = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (!/^\s*\|/.test(line)) {
      inTable = false;
      const heading = /^##\s+(.*)$/.exec(line);
      if (heading) inSection = (heading[1] as string).trim() === 'Render sites';
      continue;
    }
    if (!inSection || /^\s*\|\s*:?-{1,}/.test(line)) continue;
    const nameCell = (splitTableRow(line).slice(1, -1)[0] ?? '').trim();
    if (!inTable) {
      inTable = true;
      tables += 1;
      if (tables > 1) refuse('the Render sites section holds a second table', line);
      if (nameCell !== 'Site')
        refuse('the Render sites table has a header other than "Site"', line);
      continue;
    }
    if (!cellOfNames.test(nameCell)) {
      refuse('a row of the Render sites table holds something other than site names', line);
    }
    for (const match of nameCell.matchAll(/`([A-Z][A-Za-z]*)`/g)) {
      entries.push({
        symbol: match[1] as string,
        type: 'mod_render_site',
        description: '',
        doc_min_version: minVersion(line),
        doc_page: page,
      });
    }
  }
  return entries;
}

/**
 * The "Elements" table of the mods reference page: the one table in that section
 * whose first header cell is "Element". Its first cell names one element in backticks,
 * plainly or as a link. The section also holds tables of props (`borderStyle`, spacing
 * steps, typography), which are not elements and are skipped by their header. A second
 * "Element" table, a table headed like one, and a first cell holding anything but an
 * element name stop the run. The records carry no description: the other cells list
 * props and apps. A "Requires Claude Code vX" note in the row dates the element.
 */
function parseModsElementTable(page: string, markdown: string): DocEntry[] {
  const entries: DocEntry[] = [];
  const refuse = (what: string, line: string): never => {
    throw new Error(
      `Docs page "${page}": ${what}: ${line.trim()}. Read the page and fix parseModsElementTable.`
    );
  };
  const cellOfName = /^(?:\[`([A-Za-z]+)`\]\([^)\s]*\)|`([A-Za-z]+)`)$/;
  let inSection = false;
  let inFence = false;
  let inTable = false;
  let elementTable = false;
  let elementTables = 0;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (!/^\s*\|/.test(line)) {
      inTable = false;
      const heading = /^##\s+(.*)$/.exec(line);
      if (heading) inSection = (heading[1] as string).trim() === 'Elements';
      continue;
    }
    if (!inSection || /^\s*\|\s*:?-{1,}/.test(line)) continue;
    const nameCell = (splitTableRow(line).slice(1, -1)[0] ?? '').trim();
    if (!inTable) {
      inTable = true;
      elementTable = nameCell === 'Element';
      // A prop table is headed by the prop; a header that names elements some other way
      // would hide a split of the Element table, so it stops the run.
      if (!elementTable && /element/i.test(nameCell)) {
        refuse('the Elements section holds a table headed like an element table', line);
      }
      if (elementTable && ++elementTables > 1)
        refuse('the Elements section holds a second Element table', line);
      continue;
    }
    if (!elementTable) continue;
    const match = cellOfName.exec(nameCell);
    if (!match)
      refuse('a row of the Elements table holds something other than an element name', line);
    entries.push({
      symbol: (match?.[1] ?? match?.[2]) as string,
      type: 'mod_element',
      description: '',
      doc_min_version: minVersion(line),
      doc_page: page,
    });
  }
  return entries;
}

/**
 * The event tables of the mods reference page: every table whose first header cell
 * is "Event", under whichever heading it sits, so a group moved out of "## Events"
 * keeps its events. The first cell names one event or more in backticks
 * (`` `prompt.fill`, `prompt.suggest` ``, sometimes as links), and the second says when
 * it fires, which is the description. The "## Events" section also holds tables of
 * event FIELDS (first header cell "Field"), whose `e.source` names are not events. Any
 * other header in that section stops the run, because a renamed event table would
 * otherwise drop its events without a word. So does a row that names no event, as for
 * the method table.
 */
function parseModsEventTables(page: string, markdown: string): DocEntry[] {
  const entries: DocEntry[] = [];
  let inSection = false;
  let inTable = false;
  let eventTable = false;
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line)) {
      // Any other line ends a table, a heading included.
      inTable = false;
      const heading = /^##\s+(.*)$/.exec(line);
      if (heading) inSection = (heading[1] as string).trim() === 'Events';
      continue;
    }
    if (/^\s*\|\s*:?-{1,}/.test(line)) continue;
    const [nameCell, firesCell] = splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());
    if (!inTable) {
      // The first row of a table is its header.
      inTable = true;
      if (inSection && nameCell !== 'Event' && nameCell !== 'Field') {
        throw new Error(
          `Docs page "${page}": a table in the Events section has the header ` +
            `${line.trim()}, which is neither an event table ("Event") nor a field ` +
            'table ("Field"). Read the page and fix parseModsEventTables.'
        );
      }
      eventTable = nameCell === 'Event';
      continue;
    }
    if (!eventTable) continue;
    const names = [...(nameCell ?? '').matchAll(/`([a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*)`/g)].map(
      (match) => match[1] as string
    );
    const description = cleanCell(firesCell ?? '');
    if (names.length === 0 || description.length < 3) {
      throw new Error(
        `Docs page "${page}": a row of an Events table has no readable event name or ` +
          `description: ${line.trim()}. Read the page and fix parseModsEventTables.`
      );
    }
    for (const symbol of names) {
      entries.push({
        symbol,
        type: 'mod_event',
        description,
        doc_min_version: minVersion(firesCell ?? ''),
        doc_page: page,
      });
    }
  }
  return entries;
}

export function parseDocPage(
  page: string,
  markdown: string,
  knownConfigKeys?: ReadonlySet<string>
): DocEntry[] {
  if (page === 'settings') return parseSettingsPage(page, markdown, knownConfigKeys);
  if (page === 'settings-reference') return parseSettingsReferencePage(page, markdown);
  if (page === 'plugins/mods/reference') return parseModsReferencePage(page, markdown);
  const entries: DocEntry[] = [];
  const sections = PAGE_SYMBOL_SECTIONS[page];
  const sectionScopes = SECTION_SCOPES[page];
  let section = '';
  let scope: string | undefined;
  let inTable = false;
  let descIndex = 1;
  let envIndex = -1;
  let header: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line)) inTable = false;
    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    if (heading) {
      section = (heading[1] as string).trim();
      // Any h2–h4 heading (the depths this regex matches) resets the scope. A
      // non-command subsection under a subcommand — `### Options` in `## plugin
      // init` — therefore
      // clears `plugin init` and per-scope capture is skipped for that table. That
      // fails SAFE (no wrong data, the feature just does not fire); the official
      // plugins-reference puts each flag table directly under its `### plugin <x>`
      // heading, so it does fire there. Revisit with heading-depth tracking only if
      // a page starts nesting flag tables under a non-command subsection.
      scope = sectionScopes?.[section] ?? scopeFromHeading(heading[1] as string);
      continue;
    }
    if (!/^\s*\|/.test(line) || /^\s*\|\s*:?-{2,}/.test(line)) continue;
    const cells = splitTableRow(line)
      .slice(1, -1)
      .map((c) => c.trim());
    const isHeader = !inTable;
    if (isHeader) {
      // The first row of a table is its header; it names the description column.
      inTable = true;
      header = cells;
      descIndex = descriptionColumn(cells);
      envIndex = envVarColumn(cells);
    }
    if (sections && !sections.has(section)) continue;
    if (sections) assertReadableRow(page, section, cells, header, isHeader);
    if (cells.length < 2) continue;
    // length >= 2 guarantees both are present, so the casts are safe.
    const symbolCell = cells[0] as string;
    const descCell = cells[descIndex] ?? (cells[1] as string);

    const envSyms =
      envIndex > 0
        ? symbolsFromCell(cells[envIndex] ?? '').filter((sym) => sym.type === 'env_var')
        : [];
    const syms = [...symbolsFromCell(symbolCell), ...envSyms];
    if (syms.length === 0) continue;
    const description = cleanCell(descCell);
    if (description.length < 3) continue;

    // Only a cell-level marker (either column) here — never the page baseline. The
    // baseline is applied page-locally in buildDocsIndex AFTER dedupe, so it can't
    // ride the cross-page min-version backfill onto an earlier page's dateless flag
    // (e.g. remote-control's 2.1.51 must not stamp cli-reference's `--verbose`).
    const doc_min_version = minVersion(descCell) ?? minVersion(symbolCell);
    for (const sym of syms) {
      entries.push({
        symbol: sym.symbol,
        type: sym.type,
        description,
        doc_min_version,
        doc_page: page,
        // Scope candidate only for flags — the per-subcommand-description case is
        // a cli_flag concern. Stripped in buildDocsIndex after the map is built.
        ...(scope && sym.type === 'cli_flag' ? { scope } : {}),
      });
    }
  }
  return [...entries, ...inheritedEntries(page, markdown, entries)];
}

/** The SCOPE_INHERITANCE copies for `page`: each named flag again, under the `to` scope. */
function inheritedEntries(
  page: string,
  markdown: string,
  entries: readonly DocEntry[]
): DocEntry[] {
  const rule = SCOPE_INHERITANCE[page];
  if (!rule) return [];
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${rule.section}`);
  const end = lines.findIndex((line, i) => i > start && /^#{2,4}\s/.test(line));
  const prose = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((line) => !/^\s*\|/.test(line))
    .join(' ');
  const missing = rule.flags.filter((flag) => !prose.includes(`\`${flag}\``));
  if (start < 0 || !prose.includes('same defaults as the runner') || missing.length > 0) {
    throw new Error(
      `Docs page "${page}": the "${rule.section}" section no longer says it accepts ` +
        `${missing.length > 0 ? missing.join(', ') : 'the runner flags'} with the same defaults ` +
        'as the runner. Read the page and update SCOPE_INHERITANCE.'
    );
  }
  return rule.flags.map((flag) => {
    const from = entries.find(
      (e) => e.symbol === flag && e.type === 'cli_flag' && e.scope === rule.from
    );
    if (!from) {
      throw new Error(
        `Docs page "${page}": SCOPE_INHERITANCE names ${flag}, which has no "${rule.from}" row to copy.`
      );
    }
    return { ...from, scope: rule.to };
  });
}

/** Merge per-page entries, first definition wins, sorted by type then symbol. */
export function buildDocsIndex(
  pages: Array<{ page: string; markdown: string }>,
  knownConfigKeys?: ReadonlySet<string>
): DocsIndex {
  const seen = new Map<string, DocEntry>();
  // key -> (subcommand scope -> that scope's description), first row per scope
  // wins. Collected across every row (winners and losers), so a flag documented
  // under two subcommands is captured even though only one row wins `seen`.
  const scopeVariants = new Map<string, Map<string, string>>();
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
      if (entry.scope) {
        let variants = scopeVariants.get(key);
        if (!variants) scopeVariants.set(key, (variants = new Map()));
        if (!variants.has(entry.scope)) variants.set(entry.scope, entry.description);
      }
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
  // Attach per-scope descriptions where a flag is documented under MORE THAN ONE
  // subcommand with DIFFERENT text (identical text under each needs no override).
  // Then strip the internal `scope` marker from every winner so it never reaches
  // docs.json. Keys that are not real scopes are dropped later, when scrape's
  // withScopes intersects this map with the record's binary-proved scopes.
  for (const [key, winner] of seen) {
    delete winner.scope;
    const variants = scopeVariants.get(key);
    if (variants && SECTION_SCOPES[winner.doc_page]) {
      const covered = [...variants]
        .filter(([, text]) => text === winner.description)
        .map(([scope]) => scope)
        .sort();
      if (covered.length > 0) winner.doc_scopes = covered;
    }
    if (!variants || variants.size < 2 || new Set(variants.values()).size < 2) continue;
    winner.scope_descriptions = Object.fromEntries(
      [...variants.entries()].sort(([a], [b]) => a.localeCompare(b))
    );
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
 * Integrity guard for the committed docs index: every `source_pages` entry must be
 * an official Claude Code docs URL, in `DOC_PAGES` order, with no duplicates, and
 * every `doc_page` must be one of those fetched pages. Catches a hand-edited or
 * corrupted `data/docs.json` before its entries are published as
 * `provenance: "docs"` with real-looking `code.claude.com/docs` source URLs.
 *
 * The list may LACK an official page. A code change that adds a page to
 * `DOC_PAGES` cannot regenerate `data/docs.json` in the same PR — data and code
 * ship separately — so the committed index lags by that page until the next docs
 * refresh. Requiring an exact match would fail every scrape in between. Yield is
 * checked separately, at fetch time, by `assertDocsCoverage`.
 */
export function assertOfficialDocs(docs: DocsIndex): void {
  const expected = officialSourcePages();
  let cursor = 0;
  const ordered = docs.source_pages.every((url) => {
    const at = expected.indexOf(url, cursor);
    cursor = at + 1;
    return at !== -1;
  });
  if (docs.source_pages.length === 0 || !ordered) {
    throw new Error(
      'Docs index source_pages do not match the official Claude Code documentation pages ' +
        '(code.claude.com/docs); refusing to publish it as provenance:"docs". ' +
        'Regenerate with "npm run fetch-docs".'
    );
  }
  const fetched = new Set(docs.source_pages);
  for (const entry of docs.symbols) {
    if (!OFFICIAL_DOC_PAGES.has(entry.doc_page)) {
      throw new Error(
        `Docs entry ${entry.symbol} references a non-official doc_page "${entry.doc_page}".`
      );
    }
    if (!fetched.has(`${DOCS_BASE}${entry.doc_page}.md`)) {
      throw new Error(
        `Docs entry ${entry.symbol} references doc_page "${entry.doc_page}", which the ` +
          'index did not fetch. Regenerate with "npm run fetch-docs".'
      );
    }
  }
}

/**
 * Yield guard for a freshly fetched index: every page with a floor in
 * `PAGE_MIN_SYMBOLS` must still own at least that many symbols. Throws naming the
 * page and both numbers, because the fix is always to read the page — an upstream
 * restructure needs a parser, an upstream deletion needs the floor lowered, and
 * the two are indistinguishable from the output alone.
 */
export function assertDocsCoverage(docs: DocsIndex): void {
  const owned = new Map<string, number>();
  for (const entry of docs.symbols) owned.set(entry.doc_page, (owned.get(entry.doc_page) ?? 0) + 1);
  for (const [page, floor] of Object.entries(PAGE_MIN_SYMBOLS)) {
    const found = owned.get(page) ?? 0;
    if (found < (floor as number)) {
      throw new Error(
        `Docs page "${page}" yielded ${found} of the ${floor} symbols its floor requires. ` +
          `Either the page was restructured and the parser no longer reads it, or the ` +
          `symbols really went away. Read ${DOCS_BASE}${page}.md and fix the parser or ` +
          `the floor in PAGE_MIN_SYMBOLS before publishing this as provenance:"docs".`
      );
    }
  }
  for (const [type, floor] of Object.entries(TYPE_MIN_SYMBOLS)) {
    const found = docs.symbols.filter((entry) => entry.type === type).length;
    if (found < (floor as number)) {
      throw new Error(
        `The docs index holds ${found} ${type} symbols, below the floor of ${floor}. ` +
          `Either the page that defines them was restructured and the parser no longer ` +
          `reads it, or they really went away. Read the page and fix the parser or the ` +
          `floor in TYPE_MIN_SYMBOLS before publishing this as provenance:"docs".`
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
  assertDocsCoverage(index);
  await writeFile(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  const withMin = index.symbols.filter((s) => s.doc_min_version).length;
  console.log(
    `Wrote ${outPath}: ${index.symbols.length} documented symbols (${withMin} with a min-version).`
  );
}

runCli(import.meta.url, 'fetching docs', main);
