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
/** How far to look around a command's `type:` for its `name`/`description`. */
const COMMAND_BACK = 250;
const COMMAND_FWD = 450;

/**
 * A flag literal is Claude Code's own when, just before one of its occurrences,
 * the code either registers it with commander or inspects `process.argv` for it.
 * Both are self-referential — a subprocess/browser flag never appears this way.
 */
const FLAG_OWN_EVIDENCE =
  /\.(?:option|addOption)\([^)]{0,85}$|argv[\s\S]{0,70}$|\b(?:includes|indexOf|startsWith)\(\s*["'`]$/;

/** `process.env.NAME` and `process.env["NAME"]` — the positive signal for env. */
const ENV_ACCESS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g,
];

/** Command-registry object marker: `type:"local"|"prompt"|"local-jsx"`. */
const COMMAND_TYPE = /type:\s*["'`](?:local|prompt|local-jsx)["'`]/g;
const COMMAND_NAME = /name:\s*["'`]([a-z][a-z0-9:-]+)["'`]/g;
const COMMAND_DESC = /description:\s*["'`]((?:[^"'`\\]|\\.)*)["'`]/g;

/** The capture of `re`'s match whose position is closest to `rel` in `window`. */
function nearest(window: string, re: RegExp, rel: number): string | undefined {
  let best = Infinity;
  let value: string | undefined;
  for (const m of window.matchAll(re)) {
    const d = Math.abs((m.index ?? 0) - rel);
    if (d < best) {
      best = d;
      value = m[1];
    }
  }
  return value;
}

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
  for (const anchor of src.matchAll(COMMAND_TYPE)) {
    if (anchor.index === undefined) continue;
    const lo = Math.max(0, anchor.index - COMMAND_BACK);
    const window = src.slice(lo, anchor.index + COMMAND_FWD);
    const rel = anchor.index - lo;

    // the name and description belonging to THIS object are the ones nearest the
    // type marker — a fixed window can otherwise reach into a neighbouring object
    const name = nearest(window, COMMAND_NAME, rel);
    if (!name) continue;
    const key = `/${name}`;
    const desc = nearest(window, COMMAND_DESC, rel);
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
