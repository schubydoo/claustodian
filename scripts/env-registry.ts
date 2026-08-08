// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — the typed env registry.
 *
 * From 2.1.160 Claude Code declares most of its environment variables in one
 * generated table: a getter map entry `NAME:()=>ref`, where `ref` is bound to a
 * typed constructor call on a builder object — `olg=$e.bool()`, `xyz=$e.str()`.
 *
 * That is STRUCTURAL evidence, and it is the point of this module. The other env
 * paths infer from a name: `process.env.X` proves a read, and the accessor-map
 * path has to fall back on the `CLAUDE_`/`ANTHROPIC_` convention plus a
 * hand-audited list to guess whether an ALL-CAPS getter key is an env var or one
 * of the many ordinary constants sharing that shape. A resolved
 * `<builder>.<type>()` binding settles the question outright: Claude Code's own
 * code declares this key as a typed environment variable.
 *
 * WHAT THIS DOES NOT DECIDE. Proving something is an env var is not proving it is
 * Claude Code's own to publish — the registry legitimately contains `GITHUB_*`,
 * `OTEL_*`, `LANG`, `TMP`. Ownership stays with `isPublishableBinaryEnv`, and at
 * 2.1.224 that withholds 91 of the 95 vars this newly proves. They are recorded
 * as evidence and left unpublished, the same posture the lane already takes
 * elsewhere; promoting any of them is a maintainer audit, not an extraction
 * change.
 *
 * FLOOR. The registry arrived fully formed at 2.1.160 (2.1.159 has no builder).
 * Below it this yields nothing and the older paths carry the lane — which is
 * why absence here is never evidence of removal.
 */

/**
 * Anchor for a candidate builder: a `str:(` key in object-key position.
 *
 * The search runs from this rather than over every `NAME={` in the bundle. A
 * 20 MB minified bundle holds tens of thousands of object assignments, and
 * reading each one's body to check its keys cost 2.2 s per version — seventeen
 * minutes across the archive, for a handful of hits. `str` is required of every
 * builder (see CORE_METHODS), so anchoring on it is both cheap and complete.
 */
const BUILDER_ANCHOR = /[{,]str:\(/g;
/** `NAME={` immediately before an anchor — the object the anchor belongs to. */
const BUILDER_OPEN = /(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*\{$/;
/** How far back from the anchor the enclosing `NAME={` may be. */
const BUILDER_LOOKBACK = 400;
/**
 * Cap on how far to read for a candidate object's body. Generous — the real
 * builder is ~130 chars — because the read STOPS at the object's own closing
 * brace; this only bounds a pathological unterminated case.
 */
const BUILDER_BODY_CAP = 2000;
/**
 * Constructors a builder must declare to be recognised. Deliberately a SUBSET,
 * not an exact set: `enum` did not exist at 2.1.160 and `triBool` had a single
 * entry there, so pinning the full set would silently zero the lane the next time
 * Anthropic adds a type. Extra unknown methods are fine and are accepted.
 */
const CORE_METHODS = ['str', 'bool', 'int'] as const;
/** An object key whose value is an arrow function — `str:()=>…`, `int:(e)=>…`. */
const OBJECT_METHOD_KEY = /[{,]([a-zA-Z]+):\(/g;
/**
 * `<builder>.<method>(` for the builder names actually found — the ANCHOR for a
 * typed binding, not the whole thing.
 *
 * Matching the full `X=<builder>.<method>(` costs 1.0 s per bundle: a leading
 * `([A-Za-z_$][\w$]*)\s*=` makes the engine attempt an identifier at nearly every
 * byte of 20 MB and backtrack. Anchoring on the builder call instead is ~850
 * matches and 45 ms; the assignment target is then read from a short look-back.
 */
const builderCallRe = (names: string[]): RegExp =>
  new RegExp(`(${names.map(escapeRegExp).join('|')})\\.([a-zA-Z]+)\\(`, 'g');

/** `X=` immediately before a builder call. */
const ASSIGN_BEFORE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*$/;
/** How far back from a builder call the assignment target may be. */
const ASSIGN_LOOKBACK = 48;

/** Escapes regex metacharacters — minified builder names are often `$`-prefixed. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** `NAME:()=>ref` in a getter map — the registry's public face. */
const REGISTRY_ENTRY = /[{,]\s*([A-Z][A-Z0-9_]{2,}):\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/g;

/**
 * The text of the object literal opening at `open`, stopping at its OWN closing
 * brace rather than after a fixed number of characters.
 *
 * A fixed window is wrong, and not subtly: the builder object is ~130 chars, so
 * a 260-char window read ~130 chars of whatever followed it and treated those
 * `key:(` occurrences as the builder's own methods. In 2.1.224 that let the
 * registry builder absorb the neighbouring graph library's `neighborhood` /
 * `incomers` / `maxDegree`, which then validated graph API calls as typed env
 * bindings. Depth-aware, and quote-aware so a brace inside a string cannot end
 * the body early.
 */
function objectBody(src: string, open: number, cap = BUILDER_BODY_CAP): string {
  let depth = 0;
  const limit = Math.min(src.length, open + cap);
  for (let i = open; i < limit; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < limit) {
        if (src[i] === '\\') i++;
        else if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open, limit);
}

interface Builder {
  at: number;
  methods: Set<string>;
}

/**
 * Every builder binding in the source, by name and position.
 *
 * Position matters because minified names are reused across module scopes. In
 * 2.1.224 `$e` is bound three times: to the registry builder, to an array, and
 * inside a bundled graph library whose methods are `neighborhood`, `incomers`,
 * `maxDegree`. Resolving a binding against the wrong `$e` would admit graph API
 * calls as environment variables.
 */
function findBuilders(src: string): Map<string, Builder[]> {
  const out = new Map<string, Builder[]>();
  const seen = new Set<number>();
  for (const anchor of src.matchAll(BUILDER_ANCHOR)) {
    // Walk back to this object's own `NAME={`. The anchor may be the first key or
    // a later one, so try each `{` going left within the lookback.
    for (let i = anchor.index; i >= Math.max(0, anchor.index - BUILDER_LOOKBACK); i--) {
      if (src[i] !== '{') continue;
      const open = BUILDER_OPEN.exec(src.slice(Math.max(0, i - 64), i + 1));
      if (!open) continue;
      if (seen.has(i)) break;
      seen.add(i);
      const methods = new Set(
        [...objectBody(src, i).matchAll(OBJECT_METHOD_KEY)].map((k) => k[1] as string)
      );
      if (CORE_METHODS.every((c) => methods.has(c))) {
        const name = open[1] as string;
        if (!out.has(name)) out.set(name, []);
        out.get(name)!.push({ at: i, methods });
      }
      break;
    }
  }
  return out;
}

/**
 * Variables bound to a typed constructor call, mapped to that type.
 *
 * A binding counts only when the NEAREST PRECEDING definition of its callee is a
 * builder AND declares the method used — so `$e.bool()` resolves against the
 * registry builder while `$e.neighborhood()` in the graph library, and any
 * `$e.*` before the builder exists, are rejected.
 */
function typedBindings(src: string, builders: Map<string, Builder[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(builderCallRe([...builders.keys()]))) {
    const [, callee, method] = m as unknown as [string, string, string];
    const defs = builders.get(callee);
    if (!defs) continue;
    const nearest = defs.filter((d) => d.at < m.index).at(-1);
    if (!nearest || !nearest.methods.has(method)) continue;
    const assign = ASSIGN_BEFORE.exec(src.slice(Math.max(0, m.index - ASSIGN_LOOKBACK), m.index));
    if (!assign) continue;
    out.set(assign[1] as string, method);
  }
  return out;
}

/**
 * Environment variables the bundle's typed registry declares, with the type it
 * declares for each. Empty below the 2.1.160 registry floor, and empty for any
 * bundle with no builder — never an error, because absence here is a normal
 * property of the older eras rather than a failure to read.
 */
export function extractRegistryEnvVars(src: string): Map<string, string> {
  const builders = findBuilders(src);
  if (builders.size === 0) return new Map();
  const bindings = typedBindings(src, builders);
  const out = new Map<string, string>();
  for (const m of src.matchAll(REGISTRY_ENTRY)) {
    const [, name, ref] = m as unknown as [string, string, string];
    const declaredType = bindings.get(ref);
    if (declaredType) out.set(name, declaredType);
  }
  return out;
}
