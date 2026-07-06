// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — extract Claude Code's own symbol surface from a bundle's source
 * text. The input is the plain JS of an npm `cli.js` (≤2.1.112) OR the embedded
 * bundle inside a compiled release binary (≥2.1.113); both preserve the source
 * as plaintext, so the same extractor serves both (see scratch/binary-spike.md).
 *
 * Guiding principle — POSITIVE-EVIDENCE INCLUSION, not scan-and-filter. Blindly
 * scanning for `--foo`/`/foo` literals drags in flags Claude Code passes to
 * subprocesses (git, browsers) and third-party API paths, and proving each one
 * is "pollution" is unreliable on a minified bundle (the git binary is a minified
 * accessor, the spawn call is renamed). So instead we only assert a symbol is
 * Claude Code's own when the code positively proves it in a way that survives
 * minification:
 *   - flags   — commander registration (`.option`/`.addOption`) OR argv
 *               inspection (`process.argv.includes/indexOf("--foo")`). A git or
 *               browser flag never appears in either.
 *   - env     — `process.env.X` access. Categorized (own / provider / noise) via
 *               the shared classifier; obvious noise dropped via the denylist.
 *   - command — the command-registry objects `{type,name,description,…}`; these
 *               are explicit definitions, and the description comes free.
 *
 * This is extraction only — no acquisition (download/unpack) and no cross-version
 * diffing. The backfill and the forward CI wrap this with those concerns.
 */
import { categorize, SYMBOL_DENYLIST, type ExtractedSymbolType } from './scrape-changelog.js';

/** How a candidate earned inclusion — recorded so the review queue can triage. */
export type Evidence = 'registration' | 'argv' | 'process-env' | 'command-registry';

export interface BundleSymbol {
  symbol: string;
  type: ExtractedSymbolType;
  /** Shared ownership/source bucket (claude-code / cloud / runtime / … / other). */
  category: string;
  evidence: Evidence;
  /** Only commands carry a description (from the registry object). */
  description?: string;
}

/** How far back to look for a flag's own-evidence marker. */
const FLAG_EVIDENCE_WINDOW = 95;
/** Cap on how far past a `type:` marker to read a command's fields — used only
 * for the last object, which has no following marker to bound it. */
const COMMAND_FWD = 450;

/**
 * A flag literal is Claude Code's own when it is either the argument of a
 * commander registration (`.option`/`.addOption`) or the argument of a
 * `process.argv` membership check (`.includes`/`.indexOf`, optionally after a
 * `.slice(n)`). Both are self-referential — a subprocess/browser flag never
 * appears this way. The argv branch requires the flag to be *inside* the
 * membership call, not merely near a `process.argv` token: an unrelated
 * `process.argv.slice(2)` sitting close to a `spawn(g,["--x"])` must not count.
 */
const FLAG_OWN_EVIDENCE =
  /\.(?:option|addOption)\([^)]{0,85}$|process\.argv(?:\.slice\(\s*\d*\s*\))?\.(?:includes|indexOf)\(\s*["'`]$/;

/** `process.env.NAME` and `process.env["NAME"]` — the positive signal for env. */
const ENV_ACCESS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g,
];

/** Command-registry object marker: `type:"local"|"prompt"|"local-jsx"`. */
const COMMAND_TYPE = /type:\s*["'`](?:local|prompt|local-jsx)["'`]/g;
/** Command name — the SAME grammar as the changelog/docs lanes
 * (`[a-z][a-z0-9-]+`, no `:`), so a binary find coalesces with the other lanes
 * instead of forking a divergent `/ns:cmd` symbol. A namespaced name won't
 * match here (skipped, not truncated). Non-global: we take the first in-object
 * match. */
const COMMAND_NAME = /name:\s*["'`]([a-z][a-z0-9-]+)["'`]/;
const COMMAND_DESC = /description:\s*["'`]((?:[^"'`\\]|\\.)*)["'`]/;

/** Env vars whose existence we assert from the bundle, keyed by access syntax. */
export function extractEnvVars(src: string): Map<string, string> {
  const out = new Map<string, string>(); // symbol -> category
  for (const pattern of ENV_ACCESS) {
    for (const m of src.matchAll(pattern)) {
      const name = m[1];
      if (!name || SYMBOL_DENYLIST.has(name)) continue;
      out.set(name, categorize(name, 'env_var'));
    }
  }
  return out;
}

/**
 * Flags with positive own-evidence. Scans every `--flag` occurrence and keeps a
 * flag the first time an occurrence carries registration or argv evidence in the
 * preceding window — so a flag that appears once as a subprocess arg and once in
 * `.option(...)` is still (correctly) kept.
 */
export function extractFlags(src: string): Map<string, Evidence> {
  const out = new Map<string, Evidence>();
  for (const m of src.matchAll(/--[a-z][a-z0-9-]+/g)) {
    const flag = m[0];
    if (out.has(flag) || m.index === undefined) continue;
    const before = src.slice(Math.max(0, m.index - FLAG_EVIDENCE_WINDOW), m.index);
    if (!FLAG_OWN_EVIDENCE.test(before)) continue;
    out.set(flag, /\.(?:option|addOption)\(/.test(before) ? 'registration' : 'argv');
  }
  return out;
}

/**
 * Slash commands from the command registry. Each `type:` marker anchors an
 * object; its nearest `name:` (required) and `description:` (optional) are read
 * from a window around it. Names are slash-less in source; we restore the `/`.
 */
export function extractCommands(src: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>(); // "/name" -> description
  const anchors = [...src.matchAll(COMMAND_TYPE)];
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i]?.index;
    if (start === undefined) continue;
    // Read only THIS object's fields: from its `type:` marker up to the next
    // command marker (capped), so an adjacent command's name/description can't
    // cross over. Fields (name, description) follow `type:` within the object.
    const bound = Math.min(anchors[i + 1]?.index ?? src.length, start + COMMAND_FWD);
    const object = src.slice(start, bound);

    const name = object.match(COMMAND_NAME)?.[1];
    if (!name) continue;
    const key = `/${name}`;
    const desc = object.match(COMMAND_DESC)?.[1];
    // first definition wins, but let a later one fill in a missing description
    if (!out.has(key)) out.set(key, desc);
    else if (out.get(key) === undefined && desc) out.set(key, desc);
  }
  return out;
}

/** Full extraction: every own-evidenced symbol, sorted by type then symbol. */
export function extractBundleSymbols(src: string): BundleSymbol[] {
  const symbols: BundleSymbol[] = [];
  for (const [symbol, category] of extractEnvVars(src)) {
    symbols.push({ symbol, type: 'env_var', category, evidence: 'process-env' });
  }
  for (const [symbol, evidence] of extractFlags(src)) {
    symbols.push({ symbol, type: 'cli_flag', category: categorize(symbol, 'cli_flag'), evidence });
  }
  for (const [symbol, description] of extractCommands(src)) {
    symbols.push({
      symbol,
      type: 'command',
      category: categorize(symbol, 'command'),
      evidence: 'command-registry',
      ...(description ? { description } : {}),
    });
  }
  return symbols.sort((a, b) =>
    a.type !== b.type ? (a.type < b.type ? -1 : 1) : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
  );
}
