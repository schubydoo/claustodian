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
 *   - env     — `process.env.X` access, OR an accessor-map getter entry
 *               `NAME:()=>…` (CC reads many vars through a generated getter map,
 *               not inline). The map shape alone is not proof — it also holds
 *               non-env constants (`NEVER`, `NUMBER_FORMAT_RANGES`: ~43% of
 *               matches) — so accessor-map entries are admitted ONLY when the
 *               classifier rates them first-party `claude-code` (CLAUDE_/ANTHROPIC_).
 *               All env symbols are categorized (own / provider / noise); noise
 *               dropped via the denylist.
 *   - command — the command-registry objects `{type,name,description,…}`; these
 *               are explicit definitions, and the description comes free.
 *
 * This is extraction only — no acquisition (download/unpack) and no cross-version
 * diffing. The backfill and the forward CI wrap this with those concerns.
 */
import { categorize, SYMBOL_DENYLIST, type ExtractedSymbolType } from './scrape-changelog.js';

/** How a candidate earned inclusion — recorded so the review queue can triage. */
export type Evidence =
  | 'registration'
  | 'argv'
  | 'process-env'
  | 'accessor-map'
  | 'command-registry'
  | 'skill-registry';

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
/** Cap on how far *before* a `type:` marker to read a command's fields, for the
 * "type-last" objects where name/description precede type (e.g. /vim, /rewind).
 * Bounded and stopped at the object's own opening brace (depth-aware) so no
 * bleed-in. Sized to clear a computed-description getter body between `name:` and
 * a trailing `type:` — e.g. `/sandbox`, whose `get description(){…}` puts `name:`
 * ~626 chars back; a tighter cap silently dropped it (see extract-bundle.test). */
const COMMAND_BACK = 700;

/**
 * A flag literal is Claude Code's own when the code positively inspects it —
 * one of:
 *   - commander registration: `.option(…)` / `.addOption(…)` (the flag is the arg);
 *   - `process.argv` membership: `.includes`/`.indexOf` (optionally after `.slice(n)`);
 *   - args-array predicate: `.find`/`.some`/`.filter((o)=>o==="--flag" …)`, including
 *     `||`/`&&`-chained comparisons in the same predicate (e.g.
 *     `t.slice(1).find((o)=>o==="--enabled"||o==="--disabled")`).
 * All are self-referential — a subprocess/browser flag never appears this way.
 * Each branch requires the flag to be *inside* the check, not merely near it:
 * an unrelated `process.argv.slice(2)` next to a `spawn(g,["--x"])` must not
 * count, and a foreign flag array literal (`new RegExp(["--write","--fix"])`)
 * has no membership call or `===` comparison, so it is correctly ignored.
 */
const FLAG_OWN_EVIDENCE =
  /\.(?:option|addOption)\([^)]{0,85}$|process\.argv(?:\.slice\(\s*\d*\s*\))?\.(?:includes|indexOf)\(\s*["'`]$|\.(?:find|some|filter)\([\s\S]{0,80}?\b\w+\s*===?\s*["'`]$/;

/** `process.env.NAME` and `process.env["NAME"]` — the positive signal for env. */
const ENV_ACCESS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]/g,
];

/**
 * Accessor-map getter entry `{ …, NAME:()=>fn, … }` — CC exposes many env vars
 * through a generated getter map rather than reading `process.env.NAME` inline.
 * Anchored to an object-key position (`{`/`,` before the name) so it can't match
 * mid-identifier. The value is a zero-arg arrow; what follows is unconstrained
 * (`()=>x` or `()=>{…}`).
 */
const ENV_ACCESSOR = /[{,]\s*([A-Z][A-Z0-9_]{2,}):\s*\(\)\s*=>/g;

/** Command-registry object marker: `type:"local"|"prompt"|"local-jsx"`. */
const COMMAND_TYPE = /type:\s*["'`](?:local|prompt|local-jsx)["'`]/g;
/** Command name — the SAME grammar as the changelog/docs lanes
 * (`[a-z][a-z0-9-]+`, no `:`), so a binary find coalesces with the other lanes
 * instead of forking a divergent `/ns:cmd` symbol. A namespaced name won't
 * match here (skipped, not truncated). Non-global: we take the first in-object
 * match. */
const COMMAND_NAME = /name:\s*["'`]([a-z][a-z0-9-]+)["'`]/;
const COMMAND_DESC = /description:\s*["'`]((?:[^"'`\\]|\\.)*)["'`]/;

/**
 * The SECOND command registry — skills and slash-menu commands. These register as
 * `FACTORY({name:"x", menuDescription|whenToUse, …})`; the minified factory name
 * varies every release, so we key on the object SHAPE: a `name:` literal (same
 * slash-less grammar as COMMAND_NAME) co-located with a `menuDescription:` or
 * `whenToUse:` marker. The built-in `type:`-tagged registry never carries those
 * markers, so extractCommands misses this whole class (e.g. /loop, /schedule,
 * /claude-in-chrome, /dream). We deliberately do NOT key on `aliases:` — that also
 * matches bundled highlight.js language grammars
 * (`{name:"crmsh",aliases:["crm","pcmk"],keywords:…}`), which are not commands.
 */
const SKILL_NAME = /name:\s*["'`]([a-z][a-z0-9-]+)["'`]/g;
const SKILL_MARKER = /(?:menuDescription|whenToUse):/;
/** How far past a `name:` to look for the marker/description — one object's worth. */
const SKILL_FWD = 400;
/** Description sources, in priority order: the slash-menu string, a plain
 * `description:` literal, then a `get description(){return"…"}` accessor. (`\b`
 * before `description` keeps the plain matcher from matching `menuDescription`.) */
const SKILL_MENU_DESC = /menuDescription:\s*["'`]((?:[^"'`\\]|\\.)*)["'`]/;
const SKILL_PLAIN_DESC = /\bdescription:\s*["'`]((?:[^"'`\\]|\\.)*)["'`]/;
const SKILL_GET_DESC = /get description\(\)\s*\{\s*return\s*["'`]((?:[^"'`\\]|\\.)*)["'`]/;

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
 * Env vars CC reads through an accessor-map getter (`NAME:()=>…`). Admitted ONLY
 * when the classifier rates the name first-party `claude-code` — the getter map
 * also holds unrelated ALL-CAPS constants (~43% of raw matches: `NEVER`,
 * `BROWSER_TOOLS`, `NUMBER_FORMAT_RANGES`, …), and the getter body (a minified
 * ref) does not itself prove a `process.env` read. The `claude-code` gate is the
 * positive first-party signal that keeps this provenance-clean; everything else
 * is left to the direct `process.env.X` path or dropped.
 */
export function extractAccessorEnvVars(src: string): Map<string, string> {
  const out = new Map<string, string>(); // symbol -> category
  for (const m of src.matchAll(ENV_ACCESSOR)) {
    const name = m[1];
    if (!name || SYMBOL_DENYLIST.has(name)) continue;
    const category = categorize(name, 'env_var');
    if (category !== 'claude-code') continue;
    out.set(name, category);
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
 * object; its `name:` (required) and `description:` (optional) are read from that
 * object's fields. Field order varies: usually `{type:…,name:…,description:…}`,
 * but some objects are "type-last" — `{name:…,description:…,type:…}` (e.g. /vim,
 * /rewind, /doctor) — where the fields precede the marker. We read forward first
 * (up to this object's closing brace, capped); if no name is there, the object is
 * type-last, so we read backward to the previous object's closing brace (capped).
 * Each direction stops at an object boundary so an adjacent command can't bleed
 * in. Names are slash-less in source; we restore the `/`.
 */

/** Index of the object's own closing brace, scanning forward from inside it at
 * `from`; brace-depth-aware so inner `{…}` (block-body fields) don't end it
 * early. Returns `cap` (clamped to the source length) if no such brace is found. */
function objectCloseFrom(src: string, from: number, cap: number): number {
  const limit = Math.min(cap, src.length);
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return limit;
}

/** Index just inside the object's own opening brace, scanning backward from
 * inside it at `to`; brace-depth-aware. Returns `floor` (clamped to 0) if no
 * such brace is found. */
function objectOpenFrom(src: string, to: number, floor: number): number {
  const limit = Math.max(floor, 0);
  let depth = 0;
  for (let i = to - 1; i >= limit; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return i + 1;
      depth--;
    }
  }
  return limit;
}

export function extractCommands(src: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>(); // "/name" -> description
  for (const anchor of src.matchAll(COMMAND_TYPE)) {
    const t = anchor.index;
    if (t === undefined) continue;

    // Forward: from the marker to this object's own closing brace (capped),
    // depth-aware so a block-body field (e.g. `isEnabled:()=>{…}`) before `name:`
    // doesn't cut the window at its inner `}`.
    const forward = src.slice(t, objectCloseFrom(src, t, t + COMMAND_FWD));
    let name = forward.match(COMMAND_NAME)?.[1];
    let desc = forward.match(COMMAND_DESC)?.[1];

    // No name after the marker → type-last object; read the fields before it,
    // back to this object's own opening brace (capped, depth-aware), so a
    // neighbour can't bleed in.
    if (!name) {
      const backStart = objectOpenFrom(src, t, t - COMMAND_BACK);
      const before = src.slice(backStart, t);
      name = before.match(COMMAND_NAME)?.[1];
      // Keep a forward-window description if the pre-type slice has none (a
      // "type-middle" object, `{name:…,type:…,description:…}`, has its name
      // before but its description after the marker).
      desc = before.match(COMMAND_DESC)?.[1] ?? desc;
    }

    if (!name) continue;
    const key = `/${name}`;
    // first definition wins, but let a later one fill in a missing description
    if (!out.has(key)) out.set(key, desc);
    else if (out.get(key) === undefined && desc) out.set(key, desc);
  }
  return out;
}

/**
 * Skill/slash-menu commands from the SECOND registry (see SKILL_NAME). For each
 * `name:` literal we read a forward window bounded by the next `name:` (so an
 * adjacent object can't bleed in, capped at SKILL_FWD) and include it only when
 * the window carries a menuDescription/whenToUse marker. Names are slash-less in
 * source; we restore the `/`. First definition wins; a later one may fill in a
 * missing description.
 */
export function extractSkillCommands(src: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>(); // "/name" -> description
  const anchors = [...src.matchAll(SKILL_NAME)];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    if (!anchor || anchor.index === undefined) continue;
    const start = anchor.index;
    const bound = Math.min(anchors[i + 1]?.index ?? src.length, start + SKILL_FWD);
    const object = src.slice(start, bound);
    if (!SKILL_MARKER.test(object)) continue;
    const name = anchor[1];
    if (!name) continue;
    const key = `/${name}`;
    const desc =
      object.match(SKILL_MENU_DESC)?.[1] ??
      object.match(SKILL_PLAIN_DESC)?.[1] ??
      object.match(SKILL_GET_DESC)?.[1];
    if (!out.has(key)) out.set(key, desc);
    else if (out.get(key) === undefined && desc) out.set(key, desc);
  }
  return out;
}

/** Full extraction: every own-evidenced symbol, sorted by type then symbol. */
export function extractBundleSymbols(src: string): BundleSymbol[] {
  const symbols: BundleSymbol[] = [];
  const envReads = extractEnvVars(src);
  for (const [symbol, category] of envReads) {
    symbols.push({ symbol, type: 'env_var', category, evidence: 'process-env' });
  }
  // Accessor-map getters fill in first-party env vars CC never reads inline. A
  // direct `process.env.X` read is the stronger signal, so it wins when both exist.
  for (const [symbol, category] of extractAccessorEnvVars(src)) {
    if (envReads.has(symbol)) continue;
    symbols.push({ symbol, type: 'env_var', category, evidence: 'accessor-map' });
  }
  for (const [symbol, evidence] of extractFlags(src)) {
    symbols.push({ symbol, type: 'cli_flag', category: categorize(symbol, 'cli_flag'), evidence });
  }
  const commands = extractCommands(src);
  for (const [symbol, description] of commands) {
    symbols.push({
      symbol,
      type: 'command',
      category: categorize(symbol, 'command'),
      evidence: 'command-registry',
      ...(description ? { description } : {}),
    });
  }
  // The skill/menu registry is separate. A dual-registered command keeps its
  // command-registry evidence — but if that entry had no description, let the
  // skill registry backfill one (its menuDescription may be the only one). Same
  // `/name` grammar, so these coalesce with the other lanes.
  for (const [symbol, description] of extractSkillCommands(src)) {
    if (commands.has(symbol)) {
      if (commands.get(symbol) === undefined && description) {
        const existing = symbols.find((s) => s.type === 'command' && s.symbol === symbol);
        if (existing) existing.description = description;
      }
      continue;
    }
    symbols.push({
      symbol,
      type: 'command',
      category: categorize(symbol, 'command'),
      evidence: 'skill-registry',
      ...(description ? { description } : {}),
    });
  }
  return symbols.sort((a, b) =>
    a.type !== b.type
      ? a.type < b.type
        ? -1
        : 1
      : a.symbol < b.symbol
        ? -1
        : a.symbol > b.symbol
          ? 1
          : 0
  );
}
