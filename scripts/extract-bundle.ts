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
import { extractSwitchCaseScopes } from './argv-scopes.js';
import { isAccessorEvidenceEnv } from './binary-lane.js';
import { extractRegistryEnvVars } from './env-registry.js';
import { categorize, SYMBOL_DENYLIST, type ExtractedSymbolType } from './scrape-changelog.js';
import { extractSettingsKeys, settingsKeyCategory } from './settings-schema.js';

/** How a candidate earned inclusion — recorded so the review queue can triage. */
export type Evidence =
  | 'registration'
  | 'argv'
  | 'argv-switch'
  | 'process-env'
  | 'accessor-map'
  | 'env-registry'
  | 'command-registry'
  | 'skill-registry'
  | 'settings-schema';

export interface BundleSymbol {
  symbol: string;
  type: ExtractedSymbolType;
  /** Shared ownership/source bucket (claude-code / cloud / runtime / … / other). */
  category: string;
  evidence: Evidence;
  /** Commands (registry object) and flags (commander `.option` spec) carry a description. */
  description?: string;
  /**
   * The env registry's own type for the value (str | bool | int | triBool | enum).
   * Recorded in the cache as observed evidence; deliberately NOT distilled or
   * published — a field that exists only for env vars and only from 2.1.160
   * would be a confusing shape in the 1.x contract. Capturing it now means the
   * data is there if that call is ever revisited.
   */
  declaredType?: string;
  /** True when the CLI registers this flag with `.hideHelp()` — see extractHiddenFlags. */
  hidden?: true;
  /**
   * For a flag proved only by a subcommand's `case"--flag":` label: the complete
   * set of invocation paths whose parsers accept it (`self-hosted-runner`,
   * `self-hosted-runner orchestrator`, …). Absent when containment could not
   * establish a complete scope — see scripts/argv-scopes.ts.
   */
  scopes?: readonly string[];
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
 *   - Option construction: `new G5("--flag", …)` whose first argument is a complete
 *     option spec — matched separately (FLAG_CTOR_SPEC + OPTION_SPEC), not by the
 *     look-back below, because a shared-factory refactor puts the `.addOption(` call
 *     out of window range entirely. See those two constants for why the spec must
 *     match end to end.
 *   - `process.argv` membership: `.includes`/`.indexOf` (optionally after `.slice(n)`);
 *   - args-array predicate: `.find`/`.some`/`.filter((o)=>o==="--flag" …)`, including
 *     `||`/`&&`-chained comparisons in the same predicate (e.g.
 *     `t.slice(1).find((o)=>o==="--enabled"||o==="--disabled")`).
 *   - switch-case dispatch: `case"--flag":` in a hand-rolled argv parser — matched
 *     separately (FLAG_SWITCH_CASE), see that constant.
 * All are self-referential — a subprocess/browser flag never appears this way.
 * Each branch requires the flag to be *inside* the check, not merely near it:
 * an unrelated `process.argv.slice(2)` next to a `spawn(g,["--x"])` must not
 * count, and a foreign flag array literal (`new RegExp(["--write","--fix"])`)
 * has no membership call or `===` comparison, so it is correctly ignored.
 */
const FLAG_OWN_EVIDENCE =
  /\.(?:option|addOption)\([^)]{0,85}$|process\.argv(?:\.slice\(\s*\d*\s*\))?\.(?:includes|indexOf)\(\s*["'`]$|\.(?:find|some|filter)\([\s\S]{0,80}?\b\w+\s*===?\s*["'`]$/;

/**
 * A `case"--flag":` label — Claude Code dispatching on its own already-parsed argv
 * in a hand-rolled parser, the shape commander-free subcommands use. `claude
 * self-hosted-runner` is the whole reason this exists: it is dispatched by raw argv
 * (`if(t[0]==="self-hosted-runner")`), hidden from `claude --help`, and parses ~28
 * flags this way, none of which the other evidence paths can see.
 *
 * Sound for the same reason the other paths are: it is self-referential. A flag
 * Claude Code merely PASSES to git or docker appears in an args array, never as a
 * case label in Claude Code's own switch — you cannot switch on a string you are
 * only forwarding. This is a narrower claim than the general `===` comparison the
 * 2026-07-10 backlog note worried about: `case` is a statement position, so it
 * cannot match a comparison against a subprocess's output or a config value.
 *
 * Capitals are captured so a camelCase label is rejected whole by FLAG_GRAMMAR
 * rather than truncated into a phantom — the same reason FLAG_TOKEN scans them.
 */
const FLAG_SWITCH_CASE = /case\s*(["'`])(--[A-Za-z][A-Za-z0-9-]*)\1\s*:/g;

/** An Option constructor and its first string argument — the candidate spec. */
const FLAG_CTOR_SPEC = /new [A-Za-z_$][\w$]*\(\s*(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

/**
 * An Option the CLI hides from `claude --help` via commander's `.hideHelp()`.
 *
 * This is Claude Code's own marker for "real, but not for you to type": the flag
 * parses and works, yet is withheld from help because something else sets it —
 * a spawning parent (`--managed-settings`, "SDK use only"), the teammate
 * orchestrator (`--agent-id`, `--team-name`), a deep link, or a deprecated alias
 * kept alive for compatibility (`--pool`, `--remote`).
 *
 * Structural, which is the point. The alternative was a hand-curated list of
 * "internal-looking" flags, and there is no way to keep such a list honest as
 * Anthropic promotes or retires them. `.hideHelp()` moves when they move.
 *
 * Matched from the constructor through the chained call, so an `.hideHelp()`
 * belonging to a LATER option cannot be attributed to this one: the gap may hold
 * only further chained calls on the same Option, never another `new X(`.
 */
const FLAG_CTOR_HIDDEN =
  /new [A-Za-z_$][\w$]*\(\s*(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1(?:(?!new [A-Za-z_$][\w$]*\().){0,400}?\.hideHelp\(\)/gs;

/** Long flags the bundle registers as hidden from `--help`. */
export function extractHiddenFlags(src: string): Set<string> {
  const hidden = new Set<string>();
  for (const m of src.matchAll(FLAG_CTOR_HIDDEN)) {
    /* v8 ignore next -- FLAG_CTOR_HIDDEN group 2 is non-optional (it can match empty, never undefined); the ?? only narrows the TS type */
    const spec = m[2] ?? '';
    if (!OPTION_SPEC.test(spec)) continue;
    for (const flag of spec.match(FLAG_TOKEN) ?? []) {
      if (FLAG_GRAMMAR.test(flag)) hidden.add(flag);
    }
  }
  return hidden;
}

/**
 * A commander option spec IN FULL: one or more `-x` / `--long` tokens (comma- or
 * space-separated, aliases optionally bracketed) and an optional `<arg>` / `[arg]`
 * placeholder — and nothing else.
 *
 * Anchored end to end, and that anchoring is the whole point. A look-back that
 * merely requires the literal to START with the flag admits any Error whose message
 * opens with a flag name — the bundle has `new lr("--configure-git: could not
 * restore hook stubs …")` and several like it, which is how a first attempt at this
 * fix published `--configure-git` and `--messaging-socket-path` as registered flags.
 * Prose after the flag is not spec syntax, so it is rejected here.
 *
 * The alias separator is a comma OR bare whitespace, because commander accepts
 * both (`"-d --debug"` is as valid as `"-d, --debug"`). 2.1.224 happens to use the
 * comma form everywhere, so this costs nothing today and stops a future style
 * change from silently dropping a flag.
 */
const OPTION_SPEC =
  /^-{1,2}[A-Za-z][A-Za-z0-9-]*(?:(?:\s*,\s*|\s+)\[?\s*-{1,2}[A-Za-z][A-Za-z0-9-]*\s*\]?)*(?:\s+[<[][^>\]]*[>\]])?$/;

/**
 * Every long-flag-shaped token, capitals INCLUDED, so a camelCase flag is seen
 * whole and can be rejected by the grammar rather than silently truncated at its
 * first capital. `--allowedTools, [--allowed-tools] <tools...>` must yield
 * `--allowedTools` (rejected, out of grammar) and `--allowed-tools` (kept) — never
 * the phantom `--allowed` a bare `/--[a-z][a-z0-9-]+/` scan produces by stopping at
 * the `T`. That phantom shipped with `--allowedTools`'s real description attached,
 * which made it look well-evidenced (scratch/parser-proto FINDINGS defect 2).
 */
const FLAG_TOKEN = /--[A-Za-z][A-Za-z0-9-]*/g;
/** The lane's flag grammar — lowercase, at least two chars. Shared with the other
 * lanes, so a binary find coalesces instead of forking a divergent symbol. */
const FLAG_GRAMMAR = /^--[a-z][a-z0-9-]+$/;

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
// Delimiter-aware: capture the opening quote (group 1) and allow the OTHER quote
// chars inside (a `"..."` description may contain an apostrophe), stopping only at
// the matching delimiter. The literal body is group 2. A plain `[^"'`]` class here
// truncated e.g. "Don't …" at the apostrophe.
const COMMAND_DESC = /description:\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/;

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
const SKILL_MENU_DESC = /menuDescription:\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/;
const SKILL_PLAIN_DESC = /\bdescription:\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/;
const SKILL_GET_DESC = /get description\(\)\s*\{\s*return\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/;

/**
 * Cleans a captured description literal (`raw`) for storage, given its opening
 * `delimiter`. Returns `undefined` for a runtime TEMPLATE literal — a BACKTICK
 * string containing `${…}` interpolation, whose value depends on a variable whose
 * MINIFIED name churns every release (captured as garbage like `Submit feedback
 * about ${K4}` or the truncated `Effort level … (${UV.join(`); a version
 * contributing no description is strictly better. A plain `"`/`'` string that
 * merely contains the text `${` is a static literal and is KEPT. Otherwise
 * unescapes the JS string escapes in a SINGLE left-to-right pass, so an escaped
 * backslash (`\\`) consumes the next char before `\n`/`\t`/`\uXXXX` can misfire on
 * it (`"C:\\new"` stays `C:\new`, not `C:` + newline + `ew`).
 */
function cleanDescription(
  raw: string | undefined,
  delimiter: string | undefined
): string | undefined {
  if (raw === undefined) return undefined;
  if (delimiter === '`' && raw.includes('${')) return undefined;
  const ESCAPES: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
  };
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_m, e: string) =>
    e[0] === 'u' ? String.fromCharCode(parseInt(e.slice(1), 16)) : (ESCAPES[e] ?? e)
  );
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
 * Env vars CC reads through an accessor-map getter (`NAME:()=>…`). Admitted only
 * on a positive first-party signal — the getter map also holds unrelated ALL-CAPS
 * constants (~43% of raw matches: `NEVER`, `BROWSER_TOOLS`,
 * `NUMBER_FORMAT_RANGES`, …), and the getter body (a minified ref) does not
 * itself prove a `process.env` read.
 *
 * The signal is `isAccessorEvidenceEnv`: the CLAUDE_/ANTHROPIC_ convention, or a
 * name on PROMOTE_CC_ENV, whose audit states it is one of Claude Code's own
 * feature toggles that merely skips the convention. Previously only the prefix
 * counted, so an already-audited var was dropped here — and when its inline
 * `process.env` read disappeared the symbol vanished from extraction and the lane
 * recorded a REMOVAL. That is how EMBEDDED_SEARCH_TOOLS, ENABLE_LSP_TOOL and
 * ENABLE_SESSION_PERSISTENCE came to carry removed_in while sitting in the tip
 * binary as `NAME:()=>ref`.
 *
 * Deliberately NOT the publication predicate, which is wider. See
 * isAccessorEvidenceEnv for why NEEDS_REVIEW_ENV cannot serve as evidence here.
 */
export function extractAccessorEnvVars(src: string): Map<string, string> {
  const out = new Map<string, string>(); // symbol -> category
  for (const m of src.matchAll(ENV_ACCESSOR)) {
    const name = m[1];
    if (!name || SYMBOL_DENYLIST.has(name)) continue;
    const category = categorize(name, 'env_var');
    if (!isAccessorEvidenceEnv(name, category)) continue;
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
  // Option constructors first: a shared factory moves the `.addOption(` call away
  // from the spec, so the look-back below cannot see it (the 2.1.84 `--cowork`
  // refactor). Registration is also the stronger label, so it should win.
  for (const m of src.matchAll(FLAG_CTOR_SPEC)) {
    /* v8 ignore next -- FLAG_CTOR_SPEC group 2 is non-optional (it can match empty, never undefined); the ?? only narrows the TS type */
    const spec = m[2] ?? '';
    if (!OPTION_SPEC.test(spec)) continue;
    for (const flag of spec.match(FLAG_TOKEN) ?? []) {
      if (FLAG_GRAMMAR.test(flag)) out.set(flag, 'registration');
    }
  }
  for (const m of src.matchAll(FLAG_TOKEN)) {
    const flag = m[0];
    if (!FLAG_GRAMMAR.test(flag) || out.has(flag) || m.index === undefined) continue;
    const before = src.slice(Math.max(0, m.index - FLAG_EVIDENCE_WINDOW), m.index);
    if (!FLAG_OWN_EVIDENCE.test(before)) continue;
    out.set(flag, /\.(?:option|addOption)\(/.test(before) ? 'registration' : 'argv');
  }
  // Last, and additive only: a switch-case label never relabels a flag the stronger
  // paths above already proved, it only reaches the hand-rolled parsers they cannot.
  for (const m of src.matchAll(FLAG_SWITCH_CASE)) {
    const flag = m[2];
    if (flag === undefined || out.has(flag) || !FLAG_GRAMMAR.test(flag)) continue;
    out.set(flag, 'argv-switch');
  }
  return out;
}

/**
 * A commander flag registration's `(flagSpec, description)` pair — ANCHORED to the
 * call so a bare array of flag strings (`["--verbose","--input-format"]`) can't be
 * mistaken for a spec/description. Matches `.option(...)` / `.addOption(...)` and
 * the minified Option constructor `new Z("--x","desc")` (incl. `.addOption(new Z(…))`).
 * The spec starts with a dash and carries the long flag; the description is the
 * next string argument.
 */
// Groups: 1 = spec delimiter, 2 = flag spec, 3 = desc delimiter, 4 = description.
const FLAG_SPEC_DESC =
  /(?:\.option|\.addOption|new [A-Za-z_$][\w$]*)\(\s*(["'`])(-{1,2}[a-z](?:(?!\1)[^\\]|\\.)*)\1\s*,\s*(["'`])((?:(?!\3)[^\\]|\\.)*)\3/g;

/**
 * Descriptions for flags that already have own-evidence (`flags`). A flag NAME is
 * NOT unique across subcommands — `--all` is "Disable all enabled plugins" on
 * `plugin disable` AND "Purge state for every project" on `project purge`, and
 * minification reorders occurrences per release — so we collect the SET of distinct
 * descriptions each flag registers in THIS bundle and emit one only when the flag
 * is UNAMBIGUOUS (exactly one distinct description). Guards: intersect with `flags`;
 * drop template-literal / flag-looking captures. A genuine cross-VERSION reword
 * (one description per bundle) is preserved.
 *
 * Every in-grammar long token the spec declares gets the description, aliases
 * included — `"--allowedTools, [--allowed-tools] <tools...>"` describes
 * `--allowed-tools`. Reading only the spec's FIRST token both truncated
 * `--allowedTools` to the phantom `--allowed` and left the real alias undescribed.
 */
export function extractFlagDescriptions(
  src: string,
  flags: ReadonlySet<string>
): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const m of src.matchAll(FLAG_SPEC_DESC)) {
    const description = cleanDescription(m[4], m[3]);
    if (!description) continue;
    if (/^-{1,2}[a-z]/.test(description)) continue; // a flag, not a description
    // FLAG_SPEC_DESC group 2 is non-optional, so a match always populates it.
    // The ?? [] IS reachable: a short-only spec has no long token.
    for (const long of m[2]!.match(FLAG_TOKEN) ?? []) {
      if (!FLAG_GRAMMAR.test(long) || !flags.has(long)) continue;
      let set = seen.get(long);
      if (!set) seen.set(long, (set = new Set()));
      set.add(description);
    }
  }
  const out = new Map<string, string>();
  for (const [long, descs] of seen) {
    if (descs.size === 1) out.set(long, [...descs][0] as string);
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
    /* v8 ignore next -- a matchAll match always carries a defined .index; the guard only narrows the TS type */
    if (t === undefined) continue;

    // Forward: from the marker to this object's own closing brace (capped),
    // depth-aware so a block-body field (e.g. `isEnabled:()=>{…}`) before `name:`
    // doesn't cut the window at its inner `}`.
    const forward = src.slice(t, objectCloseFrom(src, t, t + COMMAND_FWD));
    let name = forward.match(COMMAND_NAME)?.[1];
    const fdm = forward.match(COMMAND_DESC);
    let desc = cleanDescription(fdm?.[2], fdm?.[1]);

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
      const bdm = before.match(COMMAND_DESC);
      desc = cleanDescription(bdm?.[2], bdm?.[1]) ?? desc;
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
    /* v8 ignore next -- anchors[i] exists for every i < length and a matchAll match always carries a defined .index; the guard only narrows the TS types */
    if (!anchor || anchor.index === undefined) continue;
    const start = anchor.index;
    const bound = Math.min(anchors[i + 1]?.index ?? src.length, start + SKILL_FWD);
    const object = src.slice(start, bound);
    if (!SKILL_MARKER.test(object)) continue;
    const name = anchor[1];
    /* v8 ignore next -- SKILL_NAME group 1 is non-optional and its grammar cannot match an empty string; the guard only narrows the TS type */
    if (!name) continue;
    const key = `/${name}`;
    const mm = object.match(SKILL_MENU_DESC);
    const mp = object.match(SKILL_PLAIN_DESC);
    const mg = object.match(SKILL_GET_DESC);
    const desc =
      cleanDescription(mm?.[2], mm?.[1]) ??
      cleanDescription(mp?.[2], mp?.[1]) ??
      cleanDescription(mg?.[2], mg?.[1]);
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
  // The typed registry (>= 2.1.160) is the only path that PROVES env-var-ness
  // structurally rather than inferring it from the name, so it outranks the
  // accessor-map guess. A direct `process.env.X` read still wins: it proves both
  // that the var exists and that this code reads it.
  const registry = extractRegistryEnvVars(src);
  for (const [symbol, declaredType] of registry) {
    if (envReads.has(symbol)) continue;
    symbols.push({
      symbol,
      type: 'env_var',
      category: categorize(symbol, 'env_var'),
      evidence: 'env-registry',
      declaredType,
    });
  }
  // Accessor-map getters fill in first-party env vars CC never reads inline, for
  // the eras and entries the registry does not cover.
  for (const [symbol, category] of extractAccessorEnvVars(src)) {
    if (envReads.has(symbol) || registry.has(symbol)) continue;
    symbols.push({ symbol, type: 'env_var', category, evidence: 'accessor-map' });
  }
  const flags = extractFlags(src);
  const flagDescriptions = extractFlagDescriptions(src, new Set(flags.keys()));
  // Scope only attaches to `argv-switch` evidence. The stronger paths are already
  // top-level or already curated, and a flag they proved must not be narrowed by a
  // subcommand parser that happens to accept the same name.
  const switchScopes = extractSwitchCaseScopes(src);
  const hiddenFlags = extractHiddenFlags(src);
  for (const [symbol, evidence] of flags) {
    const description = flagDescriptions.get(symbol);
    const scopes = evidence === 'argv-switch' ? switchScopes.get(symbol) : undefined;
    symbols.push({
      symbol,
      type: 'cli_flag',
      category: categorize(symbol, 'cli_flag'),
      evidence,
      ...(description ? { description } : {}),
      ...(scopes ? { scopes } : {}),
      ...(hiddenFlags.has(symbol) ? { hidden: true as const } : {}),
    });
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
        // Every key of `commands` was pushed into `symbols` as a command by the
        // loop just above, so the find always succeeds.
        const existing = symbols.find((s) => s.type === 'command' && s.symbol === symbol)!;
        existing.description = description;
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
  // Settings keys from the embedded zod schema. This throws rather than
  // returning a partial set when the schema is present but unwalkable, and that
  // is deliberate: a shrunken key set is indistinguishable downstream from ~230
  // keys being deleted upstream. Failing the whole version is the safe answer.
  for (const key of extractSettingsKeys(src)) {
    symbols.push({
      symbol: key.path,
      type: 'config_key',
      category: settingsKeyCategory(key.description),
      evidence: 'settings-schema',
      ...(key.description ? { description: key.description } : {}),
    });
  }
  return symbols.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.symbol < b.symbol) return -1;
    /* v8 ignore next -- every producing loop dedupes, so no two symbols share (type, symbol) and equality cannot occur */
    if (a.symbol === b.symbol) return 0;
    return 1;
  });
}
