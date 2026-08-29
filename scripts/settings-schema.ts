// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — settings keys. Walks the zod schema Claude Code embeds for
 * `settings.json` and returns one dotted path per configurable key, with the
 * Anthropic-authored `.describe()` text where the schema carries one.
 *
 * Regex cannot do this. The schema is one deeply nested object literal whose
 * values are chained calls carrying their own parens, strings and nested
 * objects, so keys are only separable by a depth-aware walk.
 *
 * TWO EMISSION ERAS, and the walk must not care which it is looking at:
 *
 *   namespaced (0.2.123 → 2.1.223)  `cleanupPeriodDays:v.number().optional()`
 *                                    objects are `v.object({…})`; the alias is
 *                                    mangled per build (`v`, `w`, `A`, `S`, `b`)
 *   tree-shaken (2.1.224 →)          `cleanupPeriodDays:lt().int().optional()`
 *                                    no namespace at all; objects are `Xt({…})`
 *                                    with a minified, per-build callee name
 *
 * So an object is detected by SHAPE — an object literal that is the argument of
 * a call — never by the name `object` or by a hardcoded alias. Anchoring on
 * either would have silently returned zero keys the moment 2.1.224 shipped,
 * which reads downstream as ~225 simultaneous removals.
 *
 * HARD-FAIL, NEVER SHRINK. Every failure path throws rather than returning a
 * partial set. A settings schema that is present but only partly walked is
 * indistinguishable, downstream, from keys being deleted upstream — and a
 * shrunken set is exactly how the research prototype invented phantom
 * `sandbox.filesystem.*` removals at 2.1.203 and 2.1.210. A version with no
 * schema at all (before 0.2.123) is a different answer and returns empty.
 */

/**
 * Long-lived top-level keys used to locate the schema root. Several, because a
 * single anchor is one upstream rename away from silently disabling the lane.
 * `cleanupPeriodDays` has been present since 0.2.123, `includeCoAuthoredBy`
 * since 1.0.x (now deprecated but still emitted), `apiKeyHelper` since 0.2.x.
 */
const ANCHOR_KEYS = ['cleanupPeriodDays', 'includeCoAuthoredBy', 'apiKeyHelper'] as const;

/**
 * An anchor key followed by a call — `key:v.number(` (namespaced) or `key:lt(`
 * (tree-shaken). Group 1 is the namespace alias when there is one, so the
 * namespaced era can still report a real zod type.
 */
const ANCHOR_RE = new RegExp(
  `(?:${ANCHOR_KEYS.join('|')}):(?:([A-Za-z_$][\\w$]*)\\.)?[A-Za-z_$][\\w$]*\\(`
);

/**
 * Text ending immediately before an object literal's `{` when that literal is a
 * call's argument: `v.object(` or `Xt(`. This is the shape test that replaces
 * matching a literal `<alias>.object({`.
 */
const CALL_BEFORE_BRACE = /(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\($/;

/** How far back from the anchor to look for the schema root. */
const ROOT_WINDOW = 400_000;
/**
 * Runaway guard, not a scope limit. The real schema nests 3 deep
 * (`sandbox.network.allowedDomains`), so exceeding this means a sub-schema
 * reference cycle rather than a genuinely deep schema — and it throws rather
 * than truncating, like every other failure here.
 */
const MAX_DEPTH = 6;

export interface SettingsKey {
  /** Dotted path, e.g. `permissions.allow` or `sandbox.network.httpProxyPort`. */
  path: string;
  /** The schema's own `.describe()` text — first-party, Anthropic-authored. */
  description?: string;
  /** Minified name of the sub-schema factory this key was reached through. */
  viaFactory?: string;
}

/** Thrown when a schema is present but cannot be walked in full. */
export class SettingsSchemaError extends Error {}

/**
 * A standalone copy of `s`, detached from the bundle it came from.
 *
 * V8 represents a substring as a SlicedString holding a pointer to its parent,
 * so a 30-character key path extracted from a 20 MB bundle keeps that whole
 * bundle alive. The archive re-extraction walks all 472 releases in one process,
 * so retaining even a few paths per version exhausts the heap (measured: OOM at
 * ~4 GB partway through the sweep). A round trip through a Buffer forces a flat
 * copy; the strings are short and there are ~230 per version, so the cost is
 * nothing next to the leak.
 */
function detach(s: string): string {
  return Buffer.from(s, 'utf8').toString('utf8');
}

/**
 * Escapes every regex metacharacter in `s` so it can be embedded in a pattern.
 *
 * A minified identifier can currently only contain `[A-Za-z0-9_$]`, so `$` is the
 * only metacharacter that actually shows up — but escaping just `$` leaves the
 * backslash and the rest unescaped, which is a latent injection into a regex
 * built from bundle content. Escape the whole set rather than the one case seen
 * so far.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Advance past a string literal starting at `j` (which is its opening quote). */
function skipString(src: string, j: number): number {
  const quote = src[j];
  j++;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === quote) return j + 1;
    j++;
  }
  return j;
}

/**
 * Index just inside the schema root's `{`, or -1.
 *
 * Searches backward from the anchor for a candidate `{` and VERIFIES each one by
 * walking it: the root is the nearest call-opened brace whose own top level
 * declares the anchor key at the anchor's position. Self-validating, so it
 * cannot silently settle on the anchor's previous sibling sub-object.
 *
 * A single forward brace-stack pass — the obvious alternative — is not reliable
 * here. It has to start near the anchor rather than at byte 0 (20 MB of minified
 * source is too far to track), and a start point chosen blind lands inside a
 * string or regex often enough to desync the stack and lose the root entirely.
 * Verification removes the guesswork: a wrong candidate simply fails the check.
 */
function schemaRootStart(
  src: string,
  anchor: number,
  anchorKey: string,
  anchorValueAt: number
): number {
  const floor = Math.max(0, anchor - ROOT_WINDOW);
  for (let i = anchor - 1; i >= floor; i--) {
    if (src[i] !== '{') continue;
    if (!CALL_BEFORE_BRACE.test(src.slice(Math.max(0, i - 64), i))) continue;
    const declaresAnchor = scanLevel(src, i + 1).some(
      (entry) => entry.key === anchorKey && entry.valueStart === anchorValueAt
    );
    if (declaresAnchor) return i + 1;
  }
  return -1;
}

/**
 * The keys declared at THIS object level, with the source span of each value.
 * Nested structures are skipped wholesale by depth counting, so a key's own
 * arguments never leak out as siblings.
 */
function scanLevel(
  src: string,
  start: number
): { key: string; valueStart: number; valueEnd: number }[] {
  const out: { key: string; valueStart: number; valueEnd: number }[] = [];
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === ')' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (c === '}') {
      if (depth === 0) break; // end of the object being walked
      depth--;
      i++;
      continue;
    }
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i, i + 60));
      if (
        m &&
        (i === start ||
          src[i - 1] === ',' ||
          // Shadowed operand: every call site starts the scan just past a `{`,
          // and any later `{` the loop passes raises `depth`, so no key match
          // can follow one mid-scan — `i === start` has already answered.
          /* v8 ignore start -- unreachable; see the comment above */
          src[i - 1] === '{')
        /* v8 ignore stop */
      ) {
        const valueStart = i + m[0].length;
        let j = valueStart;
        let d = 0;
        while (j < src.length) {
          const cc = src[j];
          if (cc === '"' || cc === "'" || cc === '`') {
            j = skipString(src, j);
            continue;
          }
          if (cc === '(' || cc === '[' || cc === '{') {
            d++;
            j++;
            continue;
          }
          if (cc === ')' || cc === ']') {
            d--;
            j++;
            continue;
          }
          if (cc === '}') {
            if (d === 0) break;
            d--;
            j++;
            continue;
          }
          if (cc === ',' && d === 0) break;
          j++;
        }
        out.push({ key: detach(m[1] as string), valueStart, valueEnd: j });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** The schema's own description for a value, if it declares one. */
function describeOf(value: string): string | undefined {
  const m = /\.describe\((["'`])((?:\\.|(?!\1).)*)\1\)/.exec(value);
  const raw = m?.[2];
  // A template literal interpolates a per-build minified variable; its text is
  // garbage across releases, so contribute nothing rather than churn.
  if (raw === undefined || (m?.[1] === '`' && raw.includes('${'))) return undefined;
  return detach(raw.replace(/\\(["'`\\])/g, '$1'));
}

/** Start of the object literal a value opens, or -1 if the value isn't one. */
function objectBodyStart(value: string, valueStart: number): number {
  const m = /^\s*((?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\()\{/.exec(value);
  return m ? valueStart + m[0].length : -1;
}

/**
 * Index just past the `}` that closes the object body starting at `bodyStart`,
 * or -1 if it never closes. Quote-aware, so a brace inside a description string
 * cannot desync the count.
 */
function objectEnd(src: string, bodyStart: number): number {
  let depth = 1;
  for (let j = bodyStart; j < src.length; j++) {
    const ch = src[j];
    if (ch === '"' || ch === "'" || ch === '`') {
      j = skipString(src, j) - 1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/**
 * A key's own description.
 *
 * For a plain value that is the whole story. For an OBJECT value it is not:
 * `describeOf` takes the first `.describe()` it sees, and every child inside the
 * body has one, so a parent object silently inherited its first child's text —
 * `worktree` was published describing the symlink array that is actually
 * `worktree.symlinkDirectories`, and 8 of 20 parents were wrong the same way.
 * A parent's own description is chained AFTER the object closes
 * (`Xt({…}).describe("…")`), so for an object we read only the tail. Parents with
 * no such chain (`sandbox`, `sandbox.network`) correctly get nothing rather than
 * a borrowed sentence.
 */
function describeKey(
  src: string,
  value: string,
  valueStart: number,
  valueEnd: number
): string | undefined {
  const bodyStart = objectBodyStart(value, valueStart);
  if (bodyStart === -1) return describeOf(value);
  const end = objectEnd(src, bodyStart);
  return end === -1 || end >= valueEnd ? undefined : describeOf(src.slice(end, valueEnd));
}

/**
 * Where a sub-schema factory's object body begins, or -1 when the factory
 * resolves to something that is not an object literal.
 *
 * Sub-schemas are emitted either as a memoized lazy binding
 * (`NAME=Se(()=>Xt({…}))`) or a plain declaration
 * (`function NAME(e){return Xt({…})}`).
 *
 * The lookbehind is `(?<![\w$])`, NOT `\b`. Minified names are frequently
 * `$`-prefixed (`$am`, `$Mm`, `$U5`), and `\b` cannot match before `$` because
 * `$` is not a word character — so a `\b`-anchored search silently failed to
 * find exactly those definitions. That single character is what produced the
 * phantom `sandbox.filesystem.*` removals at 2.1.203 and 2.1.210.
 *
 * Throws when the factory has no definition at all: that is a genuinely
 * unwalkable schema, not an empty one. A factory that resolves to a non-object
 * (a `record`/map schema keyed by caller-supplied names, e.g. `env` and
 * `hooks`, or a scalar) returns -1 — it has no fixed keys to enumerate, which is
 * a different and legitimate answer. Detecting that by shape rather than by the
 * name `record` is deliberate: the tree-shaken era has no readable type names.
 */
function factoryBodyStart(
  src: string,
  name: string,
  path: string,
  refAt: number,
  cache: Map<string, RegExpExecArray[]>
): number {
  const id = escapeRegExp(name);
  const patterns = [
    // memoized lazy binding — `NAME=Se(()=>Xt({…}))`
    `(?<![\\w$])${id}\\s*=\\s*[A-Za-z_$][\\w$]*\\(\\([^)]{0,40}\\)\\s*=>\\s*`,
    // plain declaration — `function NAME(e){return Xt({…})}`
    `function ${id}\\([^)]{0,40}\\)\\{return\\s*`,
    // direct binding — `NAME=Rt(qt(),Xt({…}))`, how the early eras emit `env`
    `(?<![\\w$])${id}\\s*=\\s*`,
  ];
  // Minified names are reused across module scopes, so "first match in 20 MB" can
  // resolve to an unrelated binding — that is how `sandbox.filesystem` went missing
  // for 91 releases while the key was plainly in the source. Bundlers emit a
  // binding near its use, so prefer the definition CLOSEST to the reference,
  // looking behind first (declaration order) and only then ahead (hoisted/lazy).
  // Memoized per bundle: without this, every key rescans the whole 20 MB source
  // for its callee, and the tree-shaken era routes every leaf's builder through
  // here — O(keys x bundle) for no gain, since a name's definitions never move.
  let all = cache.get(name);
  if (all === undefined) {
    all = [];
    for (const pattern of patterns) {
      all = [...src.matchAll(new RegExp(pattern, 'g'))] as RegExpExecArray[];
      if (all.length > 0) break;
    }
    cache.set(name, all);
  }
  const def = all.filter((m) => m.index < refAt).at(-1) ?? all.find((m) => m.index >= refAt);
  if (!def) {
    throw new SettingsSchemaError(
      `settings schema: sub-schema factory ${name}() for "${path}" has no resolvable definition. ` +
        `Refusing to emit a partial key set (it would read as removals downstream).`
    );
  }
  const bodyAt = def.index + def[0].length;
  return objectBodyStart(src.slice(bodyAt, bodyAt + 80), bodyAt);
}

/**
 * Every configurable key in the bundle's settings schema.
 *
 * Returns `[]` when the bundle has no settings schema at all (before 0.2.123).
 * Throws `SettingsSchemaError` when a schema IS present but cannot be walked in
 * full — an unrecognised emission shape, an unreachable root, an unresolvable
 * sub-schema factory, or a root that yields nothing. Callers must let that
 * propagate and fail the version.
 */
/** A `shape:()=>({` member — either a gated settings fragment or zod's own. */
const SHAPE_FACTORY = /shape\s*:\s*\(\)\s*=>\s*\(\{/g;

/**
 * `buildGate` and `shape` as members of the SAME object literal — the structural
 * proof that a `shape()` factory is a settings fragment rather than zod's
 * internals. Only simple members may sit between them, which keeps this a
 * containment claim about one object rather than a proximity guess.
 */
const GATED_FRAGMENT = /buildGate\s*:\s*\(\)\s*=>\s*[^;{}]{0,80}?,\s*shape\s*:\s*\(\)\s*=>\s*\(\{/g;

/**
 * zod's ZodObject builds its own `shape:()=>({...this._def.shape(), …})` inside
 * `.extend()` / `.merge()`. Those are library plumbing, not Claude Code settings,
 * and they are told apart by what the body opens with, not by where they sit.
 */
const ZOD_INTERNAL_SHAPE = /^\s*\.\.\.\s*this\._def/;

/**
 * Every gated settings fragment's object body, as an offset just inside its `({`.
 *
 * Throws on a `shape()` factory that is neither gated nor zod's own. That is the
 * module's standing posture — a fragment shape we do not recognise means keys are
 * going missing, and reporting success while silently dropping them is the exact
 * failure this file exists to prevent.
 */
function gatedFragments(src: string): { bodyStart: number }[] {
  const gated = new Set<number>();
  for (const m of src.matchAll(GATED_FRAGMENT)) gated.add(m.index + m[0].length);

  const out: { bodyStart: number }[] = [];
  for (const m of src.matchAll(SHAPE_FACTORY)) {
    const bodyStart = m.index + m[0].length;
    if (gated.has(bodyStart)) {
      out.push({ bodyStart });
      continue;
    }
    if (ZOD_INTERNAL_SHAPE.test(src.slice(bodyStart, bodyStart + 40))) continue;
    throw new SettingsSchemaError(
      `settings schema: a shape() factory at ${bodyStart} is neither gated by buildGate ` +
        `nor one of zod's own. The fragment registry likely changed shape; refusing to ` +
        `emit a key set that may be missing its keys.`
    );
  }
  return out;
}

export function extractSettingsKeys(src: string): SettingsKey[] {
  const anchorMatch = ANCHOR_RE.exec(src);
  if (!anchorMatch) return []; // no settings schema in this era — legitimately empty

  // String.prototype.split never returns an empty array.
  const anchorKey = anchorMatch[0].split(':')[0]!;
  const anchorValueAt = anchorMatch.index + anchorKey.length + 1;
  const root = schemaRootStart(src, anchorMatch.index, anchorKey, anchorValueAt);
  if (root === -1) {
    throw new SettingsSchemaError(
      'settings schema: found an anchor key but could not reach the enclosing schema root. ' +
        'The emission shape likely changed; refusing to emit a partial key set.'
    );
  }

  const keys: SettingsKey[] = [];
  const alias = anchorMatch[1];
  const defCache = new Map<string, RegExpExecArray[]>();
  const walk = (start: number, prefix: string, depth: number, viaFactory?: string): void => {
    if (depth > MAX_DEPTH) {
      // Returning here would drop every key below this point while reporting
      // success — the exact silent shrink this module exists to prevent. The cap
      // is a runaway guard (a cyclic sub-schema reference), not a scope limit:
      // the real schema nests 3 deep, so reaching 6 means something is wrong.
      throw new SettingsSchemaError(
        `settings schema: nesting exceeded ${MAX_DEPTH} levels at "${prefix}". ` +
          `Refusing to emit a truncated key set.`
      );
    }
    for (const { key, valueStart, valueEnd } of scanLevel(src, start)) {
      const value = src.slice(valueStart, valueEnd);
      const path = prefix ? `${prefix}.${key}` : key;
      keys.push({
        path: detach(path),
        description: describeKey(src, value, valueStart, valueEnd),
        viaFactory,
      });

      const inlineBody = objectBodyStart(value, valueStart);
      if (inlineBody !== -1) {
        walk(inlineBody, path, depth + 1, viaFactory);
        continue;
      }
      // A two-argument keyed combinator — `record(keySchema,valueSchema)` /
      // `map(...)` — passed its schemas INLINE: `Pe(i(),i())`, first argument a
      // call and a comma at the argument top level. It keys on caller-supplied
      // names, so it has no fixed sub-keys to enumerate, exactly like the `env` and
      // `hooks` record schemas the resolver already yields nothing for.
      //
      // Skip it BEFORE resolving the callee, because the callee name is minified
      // and reused across module scopes: resolving it can land on an unrelated
      // object literal and send the walk chasing phantom keys. At 2.1.251 the
      // record builder `function Pe(){return new kn({type:"record"…})}` and two
      // unrelated `Pe=m(()=>…)` lazy objects were all minified to `Pe`, so
      // `modelOverrides:Pe(i(),i())` resolved to an object 1.9 MB away and the walk
      // invented a `modelOverrides.enabled.pricing_tiers…` cycle until the depth
      // guard refused the whole version.
      //
      // Deliberately narrow to the TWO-arg form. A one-arg combinator (`array`,
      // `H(i())`) resolves to a non-object and already yields no children, so it
      // needs no help here — and matching it would change what a same-named
      // collision currently descends into elsewhere (`permissions.args:H(i())` at
      // 2.1.248/250), i.e. edit committed history rather than fix this break.
      if (/^\s*[A-Za-z_$][\w$]*\(\s*[A-Za-z_$][\w$]*\((?:[^()]|\([^()]*\))*\)\s*,/.test(value))
        continue;
      // Not an inline object, but it may still REFERENCE a sub-schema binding.
      // Both forms occur and they look different: called (`permissions:zWl(e)`)
      // and chained (`read:H10.optional()`). Matching only the called form is
      // what silently dropped `sandbox.filesystem.read.*` at 1.0.116 — the walk
      // reported success while four keys went missing.
      const ref = /^\s*([A-Za-z_$][\w$]*)\s*[.(]/.exec(value);
      const name = ref?.[1];
      // In the namespaced era the alias leads every builder value (`v.string()`),
      // which is a schema type, not a sub-schema to descend into. The tree-shaken
      // era has no alias, so every candidate is resolved and judged by its body.
      if (!name || name === alias) continue;
      const body = factoryBodyStart(src, name, path, valueStart, defCache);
      if (body !== -1) walk(body, path, depth + 1, name);
    }
  };
  walk(root, '', 0);

  // Feature-gated fragments contribute top-level keys the root walk cannot reach:
  // they live in a separate registry (`{autoMode:{buildGate:()=>!0,shape:()=>({…})}}`)
  // that the schema merges in at build time, so nothing in the root object points
  // at them. At 2.1.226 that hid `autoMode`, `useAutoModeDuringPlan`,
  // `disableDeepLinkRegistration`, `voiceEnabled`, `axScreenReader` and
  // `defaultView` — five of which settings.md documents, which is how the gap
  // surfaced.
  const rootCount = keys.length;
  for (const { bodyStart } of gatedFragments(src)) walk(bodyStart, '', 1, 'gated-fragment');

  // A bundle can embed the same module graph twice — 2.1.113 carries two copies of
  // the fragment registry, so every gated key was collected twice. A duplicate from
  // a repeated region is not new information. Deduping only the fragment tail keeps
  // the root walk's output byte-identical, and a root declaration wins over a
  // fragment of the same name because the root is the authoritative shape.
  const seen = new Set(keys.slice(0, rootCount).map((k) => k.path));
  const deduped = keys.slice(0, rootCount);
  for (const key of keys.slice(rootCount)) {
    if (seen.has(key.path)) continue;
    seen.add(key.path);
    deduped.push(key);
  }
  keys.length = 0;
  keys.push(...deduped);

  // Invariant guard, not a reachable path today: schemaRootStart only accepts a
  // root after scanLevel proves it declares the anchor key, so a located root
  // always yields at least that one. Kept — and deliberately untestable — because
  // it is the last thing standing between a future change in root-finding and
  // silently publishing "this version has no settings".
  /* v8 ignore next 5 -- deliberately untestable, per the invariant-guard comment above: schemaRootStart only accepts a root that declares the anchor key */
  if (keys.length === 0) {
    throw new SettingsSchemaError(
      'settings schema: reached the root but read zero keys. Refusing to report an empty schema.'
    );
  }
  return keys;
}

/**
 * The category for a settings key: `settings`, or `settings-internal` when the
 * key's own description marks it `@internal` — plumbing Anthropic does not intend
 * users to set.
 *
 * Internal-ness is CATEGORY, never TYPE, and that distinction is load-bearing.
 * A record's identity across versions is `type:symbol`, so deriving the type from
 * description text makes the identity churn whenever Anthropic edits a
 * description — the symbol appears to be removed under the old type and
 * introduced under the new one on the same release. That is not hypothetical: at
 * 2.1.154 the `@internal` prefix was dropped from `disableWorkflows`, and typing
 * off the description published a false removal at exactly that version while
 * the key sat untouched in the schema. `precomputeCompactionEnabled` (2.1.219)
 * and `totalTokensReminder` (2.1.202) split the same way.
 *
 * Category is descriptive rather than identifying, so the same edit now just
 * updates the record. `internal_config_flag` stays in the schema's type enum —
 * it is a published contract — but nothing emits it: no stable signal
 * distinguishes an internal settings key from a regular one at the type level.
 */
export function settingsKeyCategory(description?: string): 'settings' | 'settings-internal' {
  return /@internal\b/i.test(description ?? '') ? 'settings-internal' : 'settings';
}
