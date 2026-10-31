// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — generator. Distils the per-version symbol extractions (produced
 * by `scripts/extract-bundle.ts` over every archived Claude Code binary) into
 * one committed, auditable evidence file: `data/binary-observations.json`.
 *
 * Evidence, not policy. This file records only *what was observed* — for each
 * own-evidenced symbol, the earliest and latest archived version whose bundle
 * contained it, plus the exact set of versions scanned (`observedVersions`).
 * The interpretation of that evidence (which symbols to publish, how to
 * categorize them, when to correct a `first_seen`) lives in the overlay,
 * `scripts/binary-lane.ts`, so the raw observations stay provenance-clean.
 *
 * `removed_in` is derived conservatively, in two ways (see binary-lane). Before
 * ~2.1.160, a clean disappearance sets it (computeBinaryRemoval). In any era, so
 * the later releases too, a flag, command or env var is removed only when the raw
 * text of every following release proves the name gone as well
 * (computeTextRemoval, from each cache file's `textAbsent`), because extractor
 * absence alone is still unreliable. The changelog remains the authority for
 * confirmed (changelog/docs) symbols' removals. Interior per-version on/off history
 * is not encoded.
 *
 * Input = the per-version cache `binary-cache/<version>.json`, a COMMITTED
 * artifact (small JSON; the 139 GB binary archive it derives from is not). Run
 * this to regenerate `data/binary-observations.json` after the cache gains a
 * version — whether from the maintainer-local `reextract-binaries` (full,
 * archive-backed) or the CI `scrape-binary` (one release, CDN-backed). Because
 * the cache is committed, CI can re-distill with no binaries or re-download.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  computeBinaryRemoval,
  computeTextRemoval,
  type BinaryDescriptions,
  type BinaryObservation,
  type BinaryObservations,
  type DescriptionEra,
} from './binary-lane.js';
import { compareVersionsAsc, type ExtractedSymbolType, runCli } from './lib.js';
import type { ControlObservation, Era, ModObservation } from './binary-lane.js';
import { CACHE_INCOMPLETE_MARKER } from './reextract-binaries.js';

/** One per-version extraction file: `binary-cache/<version>.json`. */
export interface BinaryCacheFile {
  version: string;
  source?: string;
  count?: number;
  symbols: Array<{
    symbol: string;
    type: ExtractedSymbolType;
    category?: string;
    evidence?: string;
    description?: string;
    /**
     * Distilled, unlike the cache-only fields above. Scope is evidence the bundle
     * itself carries (the parser module's `Usage: claude <path>` banner), not an
     * interpretation layered on top, so it belongs in the observation file — the
     * publish/withhold decision it feeds still lives in binary-lane.ts.
     */
    scopes?: readonly string[];
    /** Registered with commander's `.hideHelp()` in this version. */
    hidden?: true;
  }>;
  /**
   * Written by both cache writers: the `type:symbol` keys of names seen in an
   * earlier release that this one neither extracts nor holds as text (textAbsent).
   * Absent in a cache predating the check, which proves nothing either way.
   */
  textAbsent?: readonly string[];
  /** Written by both cache writers; absent in a cache predating the control lane. */
  controlMessages?: ReadonlyArray<{
    symbol: string;
    family: 'control_request';
    direction: 'host_to_cli' | 'cli_to_host' | null;
    description: string;
    evidence: 'schema' | 'call_site' | 'dispatch';
    admittedBy: 'union' | 'dispatch' | 'both';
  }>;
  /**
   * Written by both cache writers: the `$.`-prefixed mods API methods. Absent in a
   * cache predating the mod lane, which is not the same as an empty list.
   */
  modMethods?: readonly string[];
  /** Method names the same bundle quotes outside the table; see modEvidenceFrom. */
  modMentions?: readonly string[];
  /** The event-only names of the mods event list. Absent in a cache predating them. */
  modEvents?: readonly string[];
  /** The render sites the release proves. Absent in a cache predating them. */
  modRenderSites?: readonly string[];
  /** Whether the render-site enum was read, so absence from modRenderSites is evidence. */
  modRenderSitesListed?: boolean;
  /** The element types the release lists. Absent in a cache predating them. */
  modElements?: readonly string[];
}

const NOTE =
  'Per-symbol observation window across archived Claude Code binaries. ' +
  'first_seen/last_seen are the earliest/latest scanned versions whose bundle ' +
  'contained the symbol (positive extraction evidence). removed_in is a conservative ' +
  'estimate: set for a clean disappearance in the reliable extraction era (< ~2.1.160), ' +
  'or in any era when the raw text of every later release (at least 3) proves the name ' +
  'gone as well; extraction absence alone is untrusted and left null. ' +
  'Generated by scripts/backfill-binary.ts; interpreted by scripts/binary-lane.ts.';

const CONTROL_NOTE =
  'Per-subtype observation window for the stream-json control protocol, across the ' +
  'archived binaries. direction_eras and description_eras are CHANGE POINTS: each holds ' +
  'from its `from` version until the next, because both values move. Resolve with ' +
  'eraValueAt — never read the last entry as the current answer for an older snapshot. ' +
  'admitted_at_first_seen is the signal that admitted the subtype AT first_seen, which ' +
  'is what makes that date checkable; `union` means it is an upper bound. Generated by ' +
  'scripts/backfill-binary.ts; interpreted by scripts/binary-lane.ts.';

const MOD_NOTE =
  'Per-method observation window for the mods API, across the archived binaries. ' +
  'first_seen/last_seen are the earliest/latest scanned versions whose dispatch table ' +
  'held the method. removed_in is the first scanned version from which the method is ' +
  'neither in the table nor quoted anywhere in the bundle, in every later scanned version ' +
  'too, while its namespace still has a table key; null otherwise. A method can leave the table and still exist, so leaving the ' +
  'table alone is not a removal. Generated by scripts/backfill-binary.ts; interpreted by ' +
  'scripts/binary-lane.ts.';

const MOD_EVENT_NOTE =
  'Per-event observation window for the mods hooks engine, across the archived binaries. ' +
  'first_seen/last_seen are the earliest/latest scanned versions whose event list held the ' +
  'event as a literal. Mods API methods are also events, but the list spreads them in ' +
  'rather than naming them, so they are not here: see mod-observations.json. removed_in is ' +
  'the first scanned version after last_seen from which the event is absent from the list ' +
  'in every later scanned version; null otherwise. Generated by scripts/backfill-binary.ts.';

const MOD_RENDER_SITE_NOTE =
  'Per-site observation window for the mods render sites, across the archived binaries. ' +
  'first_seen/last_seen are the earliest/latest scanned versions that proved the site, by ' +
  'the render-site enum or a useRenderInput call. removed_in is the first scanned version ' +
  'after last_seen whose render-site enum was read: the calls are not known to be the whole list, so ' +
  'their absence proves nothing. null otherwise. Generated by scripts/backfill-binary.ts.';

const MOD_ELEMENT_NOTE =
  'Per-element observation window for the mods ui.render elements, across the archived ' +
  'binaries. first_seen/last_seen are the earliest/latest scanned versions whose per-app ' +
  'element lists held the element. removed_in is the first scanned version after last_seen, ' +
  'from which the element is absent in every later scanned version; null otherwise. ' +
  'Generated by scripts/backfill-binary.ts.';

const DEFAULT_CACHE_DIR = 'binary-cache';
const DEFAULT_OUT_PATH = 'data/binary-observations.json';

/** Sorts symbols deterministically by type then symbol name (matches other lanes). */
function compareObservations(a: BinaryObservation, b: BinaryObservation): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.symbol < b.symbol) return -1;
  /* v8 ignore next -- observations are unique per type:symbol key, so equality cannot occur */
  if (a.symbol === b.symbol) return 0;
  return 1;
}

/**
 * Reduces the per-version cache files to one observation window per symbol.
 * Pure (no fs) so it is unit-testable against in-memory fixtures. A symbol's
 * `first_seen` is the numerically-earliest version it appears in, `last_seen`
 * the latest, and `removed_in` a conservative cliff-aware disappearance estimate
 * (see computeBinaryRemoval and computeTextRemoval; null for symbols still present or
 * too noisy to judge).
 * `observedVersions` is the full scanned set, newest first.
 */
export function distillObservations(files: BinaryCacheFile[]): BinaryObservations {
  const observedVersions = files
    .map((file) => file.version)
    .sort((a, b) => compareVersionsAsc(b, a));

  // The releases whose text proves each name absent; see computeTextRemoval.
  const provenAbsent = new Map<string, Set<string>>();
  for (const file of files)
    for (const key of file.textAbsent ?? []) {
      let set = provenAbsent.get(key);
      if (!set) provenAbsent.set(key, (set = new Set()));
      set.add(file.version);
    }

  // Collect every version each symbol was seen in, then derive the window.
  const seenIn = new Map<
    string,
    {
      symbol: string;
      type: ExtractedSymbolType;
      versions: string[];
      strongEvidence: boolean;
      /** Each scope, unioned across versions, with the earliest version that proved it. */
      scopeFrom: Map<string, string>;
      /** Each scope with the latest version that proved it; see the guard below. */
      scopeUntil: Map<string, string>;
      /** The latest version that proved any scope for the symbol. */
      lastScoped: string | undefined;
      /** Versions that registered the flag as hidden, collapsed into eras below. */
      hiddenIn: Set<string>;
      /** Versions that registered the command under its own name, not as an alias. */
      namedIn: string[];
      /** Versions whose only proof was a child-env key; see the removal below. */
      childEnvIn: Set<string>;
    }
  >();
  for (const file of files) {
    for (const { symbol, type, evidence, scopes, hidden } of file.symbols) {
      const key = `${type}:${symbol}`;
      // Evidence is per-version and can strengthen over releases (a flag parsed by a
      // switch in one release may be commander-registered in the next). Track whether
      // ANY version proved it by something other than a switch-case label, so the
      // scope caveat is dropped the moment better evidence exists.
      const strong = evidence !== 'argv-switch';
      const named = evidence !== 'command-alias';
      let entry = seenIn.get(key);
      if (entry) {
        entry.versions.push(file.version);
        entry.strongEvidence ||= strong;
        if (hidden) entry.hiddenIn.add(file.version);
        if (named) entry.namedIn.push(file.version);
        if (evidence === 'child-env') entry.childEnvIn.add(file.version);
      } else {
        entry = {
          symbol,
          type,
          versions: [file.version],
          strongEvidence: strong,
          scopeFrom: new Map(),
          scopeUntil: new Map(),
          lastScoped: undefined,
          hiddenIn: new Set(hidden ? [file.version] : []),
          namedIn: named ? [file.version] : [],
          childEnvIn: new Set(evidence === 'child-env' ? [file.version] : []),
        };
        seenIn.set(key, entry);
      }
      for (const s of scopes ?? []) {
        const from = entry.scopeFrom.get(s);
        if (from === undefined || compareVersionsAsc(file.version, from) < 0) {
          entry.scopeFrom.set(s, file.version);
        }
        const until = entry.scopeUntil.get(s);
        if (until === undefined || compareVersionsAsc(file.version, until) > 0) {
          entry.scopeUntil.set(s, file.version);
        }
      }
      if (scopes?.length) {
        if (
          entry.lastScoped === undefined ||
          compareVersionsAsc(file.version, entry.lastScoped) > 0
        )
          entry.lastScoped = file.version;
      }
    }
  }

  const symbols: BinaryObservation[] = [];
  for (const {
    symbol,
    type,
    versions,
    strongEvidence,
    scopeFrom,
    scopeUntil,
    lastScoped,
    hiddenIn,
    namedIn,
    childEnvIn,
  } of seenIn.values()) {
    const sorted = [...versions].sort(compareVersionsAsc);
    // Scopes are a union across releases, so a subcommand that later stops accepting
    // the flag would stay listed in every later snapshot (issue 503). No archived flag
    // does that yet, so this refuses to guess and stops the run instead. A release
    // that proves no scope at all is not a loss: only one that proves other scopes for
    // the flag, without this one, is.
    if (!strongEvidence && lastScoped !== undefined) {
      for (const [scope, until] of scopeUntil) {
        if (compareVersionsAsc(until, lastScoped) < 0) {
          throw new Error(
            `backfill-binary: ${type}:${symbol} has scope "${scope}" until ${until}, but ` +
              `${lastScoped} still scopes it without that one. A scope union would keep ` +
              `"${scope}" in every later snapshot. Check the releases and decide how to ` +
              'record a scope that ends before regenerating (see issue 503).'
          );
        }
      }
    }
    const namedFirst = [...namedIn].sort(compareVersionsAsc)[0] ?? null;
    // A scope is evidence from the version that proved it, not from the flag's
    // first_seen, so a subcommand a later release adds is not back-dated onto older
    // snapshots by the union.
    const lateScopes = [...scopeFrom]
      .filter(([, from]) => from !== sorted[0])
      .sort(([a], [b]) => a.localeCompare(b));
    // Visibility is a TIMELINE, not a current state. Six flags flip between
    // hidden and public across the archive (--teleport, --task-budget, --cloud,
    // --interactive, --max-budget-usd, --remote-control), so collapsing to the
    // latest value would stamp today's answer on every historical snapshot —
    // the same defect the config_key category and the scopes field each had.
    // Only change points are emitted, and only when the flag was ever hidden.
    const hiddenEras: { from: string; hidden: boolean }[] = [];
    for (const v of sorted) {
      const isHidden = hiddenIn.has(v);
      if (hiddenEras[hiddenEras.length - 1]?.hidden !== isHidden) {
        hiddenEras.push({ from: v, hidden: isHidden });
      }
    }
    // A leading "not hidden" era carries no information — absence says the same.
    if (hiddenEras[0]?.hidden === false) hiddenEras.shift();
    symbols.push({
      symbol,
      type,
      first_seen: sorted[0] as string,
      last_seen: sorted[sorted.length - 1] as string,
      // The pre-ceiling rule first, as before. Text proof covers every era, the
      // later releases the ceiling refuses included. The pre-ceiling rule trusts an
      // absence because the read-based rules were measured reliable there; the
      // child-env rule was not, so a name last proved by it needs the text proof.
      removed_in:
        (childEnvIn.has(sorted[sorted.length - 1] as string)
          ? null
          : computeBinaryRemoval(versions, observedVersions)) ??
        computeTextRemoval(
          versions,
          provenAbsent.get(`${type}:${symbol}`) ?? new Set(),
          observedVersions
        ),
      ...(hiddenEras.length ? { hidden_eras: hiddenEras } : {}),
      // Only a command first seen as an alias carries this; see named_first_seen.
      ...(namedFirst !== sorted[0] ? { named_first_seen: namedFirst } : {}),
      // Scope rides with the caveat it lifts. A symbol with strong evidence
      // somewhere publishes top-level, and narrowing it by a subcommand parser
      // that accepts the same name would be a false claim, not a refinement.
      ...(strongEvidence
        ? {}
        : {
            switch_case_only: true as const,
            ...(scopeFrom.size ? { scopes: [...scopeFrom.keys()].sort() } : {}),
            ...(lateScopes.length ? { scope_first_seen: Object.fromEntries(lateScopes) } : {}),
          }),
    });
  }

  return {
    $generated_by: 'scripts/backfill-binary.ts',
    source: 'binary',
    note: NOTE,
    observedVersions,
    symbols: symbols.sort(compareObservations),
  };
}

const DESC_NOTE =
  'Per-symbol description timeline across archived Claude Code binaries: the ' +
  'command/skill registry description captured per version, collapsed to change ' +
  'points (eras). Each era holds from the given version until the next. Lets a ' +
  'snapshot carry the description the symbol actually had at that version instead ' +
  'of one current string. Generated by scripts/backfill-binary.ts; consumed by ' +
  'scripts/scrape-changelog.ts.';

/**
 * Distills a per-symbol description timeline from the cache: for every symbol that
 * carries a registry description, collect (version, description) across all cache
 * files and collapse consecutive-equal descriptions into eras (a new era only when
 * the text changes). A recall gap (a version that missed the symbol) is spanned by
 * the surrounding era — the same version-bounded imprecision as first_seen.
 */
/**
 * Collapse runs of repeated spaces and trim the ends. A cosmetic spacing change in
 * the source (e.g. "Maximum thinking tokens.  (only…" → "…tokens. (only…", a double
 * space becoming single) is NOT a real description change, so normalizing here stops
 * it spawning a spurious "duplicate-looking" era. Only repeated SPACES are collapsed
 * — newlines and tabs are left intact so a genuinely multi-line description (an
 * indented option list / example that cleanDescription preserves) keeps its structure
 * and is not flattened or merged with a differently-structured era. cleanDescription
 * (the extractor) remains the authoritative content filter.
 */
function normalizeDescriptionWhitespace(text: string): string {
  return text.replace(/ {2,}/g, ' ').trim();
}

export function distillDescriptions(files: BinaryCacheFile[]): BinaryDescriptions {
  const seen = new Map<string, Array<{ version: string; description: string }>>();
  for (const file of files) {
    for (const s of file.symbols) {
      // The extractor (cleanDescription) is the authoritative description filter —
      // it drops backtick TEMPLATE literals but KEEPS a static quoted string that
      // merely contains "${". Don't re-filter `${` here: the cache no longer carries
      // the delimiter, so a broader `${` skip would wrongly drop a valid static one.
      if (!s.description) continue;
      const key = `${s.type}:${s.symbol}`;
      const arr = seen.get(key) ?? [];
      arr.push({
        version: file.version,
        description: normalizeDescriptionWhitespace(s.description),
      });
      seen.set(key, arr);
    }
  }

  const descriptions: Record<string, DescriptionEra[]> = {};
  for (const key of [...seen.keys()].sort()) {
    const observations = [
      ...(seen.get(key) as Array<{ version: string; description: string }>),
    ].sort((a, b) => compareVersionsAsc(a.version, b.version));
    const eras: DescriptionEra[] = [];
    for (const obs of observations) {
      const last = eras[eras.length - 1];
      if (!last || last.description !== obs.description) {
        eras.push({ from: obs.version, description: obs.description });
      }
    }
    descriptions[key] = eras;
  }

  return {
    $generated_by: 'scripts/backfill-binary.ts',
    source: 'binary',
    note: DESC_NOTE,
    descriptions,
  };
}

/**
 * Control-request subtypes distilled across the archive, one entry per subtype.
 *
 * Mirrors `distillObservations`: same window derivation, same removal rule, and the
 * same change-point treatment for anything that moves. What moves here is `direction`
 * (null everywhere until the CLI declared the two directional unions at 2.1.133) and
 * `description` (absent before 2.1.63, rewordable after), so both are eras.
 */
export function distillControlObservations(files: BinaryCacheFile[]): ControlObservation[] {
  const observedVersions = files
    .map((file) => file.version)
    .sort((a, b) => compareVersionsAsc(b, a));

  type Direction = ControlObservation['direction_eras'][number]['value'];
  type Evidence = ControlObservation['evidence_eras'][number]['value'];
  type Family = ControlObservation['family'];
  type PerVersion = {
    family: Family;
    direction: Direction;
    description: string;
    evidence: Evidence;
    admittedBy: ControlObservation['admitted_at_first_seen'];
  };
  const seenIn = new Map<string, { symbol: string; byVersion: Map<string, PerVersion> }>();

  for (const file of files) {
    for (const message of file.controlMessages ?? []) {
      const entry = seenIn.get(message.symbol) ?? { symbol: message.symbol, byVersion: new Map() };
      entry.byVersion.set(file.version, {
        family: message.family,
        direction: message.direction,
        description: message.description,
        evidence: message.evidence,
        admittedBy: message.admittedBy,
      });
      seenIn.set(message.symbol, entry);
    }
  }

  const observations: ControlObservation[] = [];
  for (const { symbol, byVersion } of seenIn.values()) {
    const versions = [...byVersion.keys()].sort(compareVersionsAsc);
    const firstSeen = versions[0] as string;

    // Change points only, walked oldest-first. `undefined` as the seed rather than a
    // real value so the first version always emits an era — otherwise a subtype whose
    // direction starts as null would have no era at all and the resolver's fallback
    // would be doing the work silently.
    const directionEras: Array<Era<Direction>> = [];
    const descriptionEras: Array<Era<string>> = [];
    const evidenceEras: Array<Era<Evidence>> = [];
    let lastDirection: Direction | undefined;
    let lastDescription: string | undefined;
    let lastEvidence: Evidence | undefined;
    for (const version of versions) {
      const at = byVersion.get(version) as PerVersion;
      if (lastDirection === undefined || at.direction !== lastDirection) {
        directionEras.push({ from: version, value: at.direction });
        lastDirection = at.direction;
      }
      if (lastDescription === undefined || at.description !== lastDescription) {
        descriptionEras.push({ from: version, value: at.description });
        lastDescription = at.description;
      }
      if (lastEvidence === undefined || at.evidence !== lastEvidence) {
        evidenceEras.push({ from: version, value: at.evidence });
        lastEvidence = at.evidence;
      }
    }

    const family = (byVersion.get(firstSeen) as PerVersion).family;
    // Carried from the cache, not hardcoded, so a widened family enum cannot relabel a
    // subtype silently. Read at first_seen like `admitted_at_first_seen`; a subtype
    // must not change family across the window (that would be a value that varies by
    // version with no era), so disagreement throws rather than picking one.
    for (const [version, at] of byVersion) {
      if (at.family !== family) {
        throw new Error(
          `${symbol}: family is ${JSON.stringify(at.family)} at ${version} but ` +
            `${JSON.stringify(family)} at ${firstSeen}. A control subtype must not ` +
            `change family across versions.`
        );
      }
    }

    observations.push({
      symbol,
      family,
      first_seen: firstSeen,
      last_seen: versions[versions.length - 1] as string,
      removed_in: computeBinaryRemoval(versions, observedVersions),
      direction_eras: directionEras,
      description_eras: descriptionEras,
      evidence_eras: evidenceEras,
      // At first_seen, NOT at the newest version: a subtype that starts as `union`
      // usually becomes `both` later, and reading the current value would un-flag it.
      admitted_at_first_seen: (byVersion.get(firstSeen) as PerVersion).admittedBy,
    });
  }

  return observations.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * The observation window of every mods API method across the cache entries that
 * the mod lane scanned. The caller guarantees every entry was scanned.
 *
 * `removed_in` needs a clean disappearance: the first scanned version after
 * `last_seen` from which the method is neither a table key nor quoted anywhere in
 * the bundle, in that version and every later one, while its namespace still has a
 * table key there (else it is not observable). Leaving the table is not enough
 * — `ui.resolve` left it at 2.1.267 and is still a method — while a renamed method
 * (`fs.readFile` -> `fs.read`) vanishes from the bundle entirely.
 */
/** `$.ui.toast` -> `ui`. */
const namespaceOf = (symbol: string): string => symbol.split('.')[1] as string;

export function distillModObservations(files: BinaryCacheFile[]): ModObservation[] {
  const scanned = files
    .flatMap(({ version, modMethods, modMentions }) =>
      modMethods === undefined
        ? []
        : [{ version, methods: modMethods, mentions: modMentions ?? [] }]
    )
    .sort((a, b) => compareVersionsAsc(a.version, b.version));
  const windows = new Map<string, { first_seen: string; last_seen: string }>();
  for (const { version, methods } of scanned) {
    for (const symbol of methods) {
      const window = windows.get(symbol);
      if (window) window.last_seen = version;
      else windows.set(symbol, { first_seen: version, last_seen: version });
    }
  }
  return (
    [...windows]
      .map(([symbol, { first_seen, last_seen }]) => {
        // Walk back from the newest version while the name is absent everywhere; the
        // earliest such version after last_seen is where it cleanly disappeared.
        let removed_in: string | null = null;
        for (let i = scanned.length - 1; i >= 0; i--) {
          const { version, methods, mentions } = scanned[i] as (typeof scanned)[number];
          if (compareVersionsAsc(version, last_seen) <= 0) break;
          if (methods.includes(symbol) || mentions.includes(symbol)) break;
          // Mentions are scoped to the table's namespaces, so where the method's whole
          // namespace has left the table it is unobservable there, not absent.
          if (!methods.some((method) => namespaceOf(method) === namespaceOf(symbol))) break;
          removed_in = version;
        }
        return { symbol, first_seen, last_seen, removed_in };
      })
      // Map keys are unique, so no two symbols compare equal.
      .sort((a, b) => (a.symbol < b.symbol ? -1 : 1))
  );
}

/**
 * The observation window of every mods event across the cache entries that the mod
 * lane scanned for events. The caller guarantees every entry was scanned.
 *
 * The event list is the whole set of events the hooks engine accepts, so leaving it
 * is a removal, unlike leaving the method table. `removed_in` still needs a clean
 * disappearance: absent from that version and every later one.
 */
export function distillModEventObservations(files: BinaryCacheFile[]): ModObservation[] {
  const scanned = files
    .flatMap(({ version, modEvents }) =>
      modEvents === undefined ? [] : [{ version, events: new Set(modEvents) }]
    )
    .sort((a, b) => compareVersionsAsc(a.version, b.version));
  const windows = new Map<string, { first_seen: string; last_seen: string }>();
  for (const { version, events } of scanned) {
    for (const symbol of events) {
      const window = windows.get(symbol);
      if (window) window.last_seen = version;
      else windows.set(symbol, { first_seen: version, last_seen: version });
    }
  }
  return (
    [...windows]
      .map(([symbol, { first_seen, last_seen }]) => {
        // last_seen is the newest version holding the event, so every scanned version
        // after it lacks the event: the first of them is the clean disappearance.
        const after = scanned.find(({ version }) => compareVersionsAsc(version, last_seen) > 0);
        return { symbol, first_seen, last_seen, removed_in: after?.version ?? null };
      })
      // Map keys are unique, so no two symbols compare equal.
      .sort((a, b) => (a.symbol < b.symbol ? -1 : 1))
  );
}

/**
 * The observation window of every mods render site across the cache entries that the
 * mod lane scanned for sites. The caller guarantees every entry was scanned.
 *
 * `removed_in` is the first scanned version after `last_seen` whose render-site enum
 * was read. Every version after `last_seen` lacks the site, but only the enum is known
 * to be the whole list. A site drawn in a way the call rule does not read would be
 * missing from the calls and still exist.
 */
export function distillModRenderSiteObservations(files: BinaryCacheFile[]): ModObservation[] {
  const scanned = files
    .flatMap(({ version, modRenderSites, modRenderSitesListed }) =>
      modRenderSites === undefined
        ? []
        : [{ version, sites: new Set(modRenderSites), listed: modRenderSitesListed === true }]
    )
    .sort((a, b) => compareVersionsAsc(a.version, b.version));
  const windows = new Map<string, { first_seen: string; last_seen: string }>();
  for (const { version, sites } of scanned) {
    for (const symbol of sites) {
      const window = windows.get(symbol);
      if (window) window.last_seen = version;
      else windows.set(symbol, { first_seen: version, last_seen: version });
    }
  }
  return (
    [...windows]
      .map(([symbol, { first_seen, last_seen }]) => {
        const after = scanned.find(
          ({ version, listed }) => listed && compareVersionsAsc(version, last_seen) > 0
        );
        return { symbol, first_seen, last_seen, removed_in: after?.version ?? null };
      })
      // Map keys are unique, so no two symbols compare equal.
      .sort((a, b) => (a.symbol < b.symbol ? -1 : 1))
  );
}

/**
 * The observation window of every mods element across the cache entries that the mod
 * lane scanned for elements. The caller guarantees every entry was scanned. The per-app
 * lists are the whole set, so leaving them is a removal, as for events.
 */
export function distillModElementObservations(files: BinaryCacheFile[]): ModObservation[] {
  return distillModEventObservations(
    files.flatMap(({ version, modElements }) =>
      modElements === undefined ? [] : [{ version, symbols: [], modEvents: modElements }]
    )
  );
}

/** Loads every `<version>.json` cache file from a directory. */
export async function loadCacheFiles(dir: string): Promise<BinaryCacheFile[]> {
  const names = (await readdir(dir)).filter(
    (name) => name.endsWith('.json') && !name.startsWith('_')
  );
  const files = await Promise.all(
    names.map(
      async (name) => JSON.parse(await readFile(join(dir, name), 'utf-8')) as BinaryCacheFile
    )
  );
  if (files.length === 0) {
    throw new Error(
      `No cache files in ${dir}. The binary archive/cache is a maintainer-local artifact; ` +
        `rebuild it (see scratch/backfill-notes.md) before regenerating the observations.`
    );
  }
  // "Zero files" is not enough: a partly-written cache is indistinguishable from a
  // complete one by its listing alone, so this reads the marker the re-extract leaves.
  const marker = join(dir, CACHE_INCOMPLETE_MARKER);
  if (existsSync(marker)) {
    throw new Error(
      `${marker} exists: the cache is not known to be complete. Read it — its ` +
        `\`status\` is in-progress (interrupted), refused (a lane could not read a ` +
        `bundle) or skipped (versions are missing from the cache, possibly because ` +
        `the archive no longer has them). Distilling now would report those versions' ` +
        `symbols as removed. Fix the cause the file names — a re-run alone does not ` +
        `clear a \`skipped\` flag, because the archive is what is short — and only ` +
        `backfill once the marker is gone.`
    );
  }
  return files;
}

interface CliOptions {
  cacheDir: string;
  outPath: string;
  control: boolean;
  mods: boolean;
  modEvents: boolean;
  modRenderSites: boolean;
  modElements: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cacheDir: DEFAULT_CACHE_DIR,
    outPath: DEFAULT_OUT_PATH,
    control: false,
    mods: false,
    modEvents: false,
    modRenderSites: false,
    modElements: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--control') options.control = true;
    if (arg === '--mods') options.mods = true;
    if (arg === '--mod-events') options.modEvents = true;
    if (arg === '--mod-render-sites') options.modRenderSites = true;
    if (arg === '--mod-elements') options.modElements = true;
    if (arg === '--cache' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a path argument (e.g. "${arg} <dir>").`);
      }
      if (arg === '--cache') options.cacheDir = value;
      else options.outPath = value;
      i++;
    }
  }
  return options;
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const files = await loadCacheFiles(options.cacheDir);

  const observations = distillObservations(files);
  await writeFile(options.outPath, `${JSON.stringify(observations, null, 2)}\n`, 'utf-8');

  // The description timeline is written alongside the observations (same dir), so
  // a scratch --out during tests keeps both outputs out of committed data/.
  const descriptions = distillDescriptions(files);
  const descPath = join(dirname(options.outPath), 'binary-descriptions.json');
  await writeFile(descPath, `${JSON.stringify(descriptions, null, 2)}\n`, 'utf-8');

  // Sibling files rather than sections of the observations, mirroring the
  // descriptions above: control_message and mod_method are different symbol types
  // with their own shapes, and widening binary-observations.json would change a file
  // every consumer of the binary lane already reads.
  const control = distillControlObservations(files);
  const mods = distillModObservations(files);
  const modEvents = distillModEventObservations(files);
  const modRenderSites = distillModRenderSiteObservations(files);
  const modElements = distillModElementObservations(files);
  const lanes: OptInLane[] = [
    {
      path: join(dirname(options.outPath), 'control-observations.json'),
      flag: '--control',
      requested: options.control,
      what: 'control observations',
      lane: 'control-lane',
      isScanned: (file) => file.controlMessages !== undefined,
      note: CONTROL_NOTE,
      symbols: control,
      summary: `${control.length} control_request subtype(s)`,
    },
    {
      path: join(dirname(options.outPath), 'mod-observations.json'),
      flag: '--mods',
      requested: options.mods,
      what: 'mod observations',
      lane: 'mod-lane',
      isScanned: (file) => file.modMethods !== undefined,
      note: MOD_NOTE,
      symbols: mods,
      summary: `${mods.length} mods API method(s)`,
    },
    {
      path: join(dirname(options.outPath), 'mod-event-observations.json'),
      flag: '--mod-events',
      requested: options.modEvents,
      what: 'mod event observations',
      lane: 'mod-lane event',
      isScanned: (file) => file.modEvents !== undefined,
      note: MOD_EVENT_NOTE,
      symbols: modEvents,
      summary: `${modEvents.length} mods event(s)`,
    },
    {
      path: join(dirname(options.outPath), 'mod-render-site-observations.json'),
      flag: '--mod-render-sites',
      requested: options.modRenderSites,
      what: 'mod render site observations',
      lane: 'mod-lane render site',
      isScanned: (file) => file.modRenderSites !== undefined,
      note: MOD_RENDER_SITE_NOTE,
      symbols: modRenderSites,
      summary: `${modRenderSites.length} mods render site(s)`,
    },
    {
      path: join(dirname(options.outPath), 'mod-element-observations.json'),
      flag: '--mod-elements',
      requested: options.modElements,
      what: 'mod element observations',
      lane: 'mod-lane element',
      isScanned: (file) => file.modElements !== undefined,
      note: MOD_ELEMENT_NOTE,
      symbols: modElements,
      summary: `${modElements.length} mods element(s)`,
    },
  ];

  const summaries = [
    `${observations.symbols.length} binary symbol(s) from ${files.length} version(s) into ` +
      `${options.outPath}`,
    `${Object.keys(descriptions.descriptions).length} description timeline(s) into ${descPath}`,
  ];
  let failed = false;
  for (const lane of lanes) {
    const outcome = await publishOptInLane(lane, files, observations.observedVersions);
    if (outcome === 'written') summaries.push(`${lane.summary} into ${lane.path}`);
    if (outcome === 'refused') failed = true;
  }
  console.log(`Distilled ${summaries.join('; ')}.`);
  return failed ? 1 : 0;
}

/** One sibling observation file whose first write is a deliberate opt-in. */
interface OptInLane {
  path: string;
  flag: '--control' | '--mods' | '--mod-events' | '--mod-render-sites' | '--mod-elements';
  requested: boolean;
  what: string;
  lane: string;
  isScanned: (file: BinaryCacheFile) => boolean;
  note: string;
  symbols: unknown[];
  summary: string;
}

/**
 * Writes one opt-in observation file, or logs why it did not.
 *
 * A cache written before a lane existed carries no key for it at all, which is not
 * the same as a cache that carries the key and found nothing. Writing `symbols: []`
 * for the first case publishes an absence as evidence — a consumer cannot tell "the
 * surface is empty" from "this cache predates the lane". So the file is written only
 * once the cache has actually been scanned; until then, no file is better than a
 * misleading one.
 *
 * `every`, not `some`. A PARTIALLY scanned cache is not "not ready yet", it is a
 * wrong-date generator: the distiller would date each symbol from the scanned
 * entries alone, so a single scanned version at the tip dates the whole surface to
 * the tip — anchored, and provably wrong against the lane's own floors.
 * `observedVersions` and the removal input are the full cache set, which is only
 * sound while the scanned set IS the full set. That is what this asserts.
 *
 * ⚠️ Being scanned is NOT sufficient to write. The release bot runs this on every
 * dispatch, from the committed cache — which IS fully scanned — so a scanned-only
 * gate would let the bot create the file, `scrape` attach the records, and the whole
 * surface reach `data/` inside an auto-mergeable `chore(data)` PR. That is the
 * code-change-plus-regeneration the hard rules forbid, arriving through the one
 * channel with no review. So publishing has to be a deliberate act: pass the lane's
 * flag once, in the data PR. After that the file EXISTS, and the bot keeps
 * refreshing it — which is the steady state the workflow wants, since committed
 * evidence that stops tracking the cache is its own defect.
 *
 * Returns `refused` only while publishing. Skipping while NOT publishing is the
 * normal path — the bot takes it on every run. Skipping while publishing is a
 * request that could not be honoured, and that includes the steady state: once the
 * file is committed, a refusal means the committed observations have silently
 * stopped tracking the cache, and nothing downstream notices.
 */
async function publishOptInLane(
  lane: OptInLane,
  files: BinaryCacheFile[],
  observedVersions: string[]
): Promise<'written' | 'skipped' | 'refused'> {
  const publishing = lane.requested || existsSync(lane.path);
  if (!publishing) {
    console.log(
      `Skipped ${lane.path}: publishing ${lane.what} is opt-in. Pass ${lane.flag} to ` +
        `write it the first time; after that its presence is the opt-in and this runs ` +
        `on every backfill.`
    );
    return 'skipped';
  }
  const unscanned = files.filter((file) => !lane.isScanned(file));
  if (unscanned.length > 0) {
    console.log(
      `Skipped ${lane.path}: ${unscanned.length} cache entry/entries carry no ` +
        `${lane.lane} output, so dating would read from the scanned subset alone. ` +
        `Re-extract first.`
    );
    return 'refused';
  }
  await writeFile(
    lane.path,
    `${JSON.stringify(
      {
        $generated_by: 'scripts/backfill-binary.ts',
        source: 'binary',
        note: lane.note,
        observedVersions,
        symbols: lane.symbols,
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
  return 'written';
}

runCli(import.meta.url, 'distilling binary observations', main);
