// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — the mods API methods (`$.ui.toast`, `$.command.run`, ...).
 *
 * A mod calls these through the `$` argument every hook receives. The bundle
 * implements them in one object literal, a dispatch table keyed by method name:
 *
 *   {"ui.toast":{check:…,run:…}, "ui.status":{check:…,run:…}, "ui.notice":Jmn, …}
 *
 * THE KEY IS THE EVIDENCE. A key in that table is a method the mods API serves.
 * The value is not evidence: later releases point many entries at a handler built
 * elsewhere (an identifier, a call), so the share of inline `{run}` values falls
 * from release to release. The size and the `run` share only PICK the table — see
 * collectModEvidence — and then every property in it must be a readable method key.
 *
 * THE TABLE IS NOT THE WHOLE API. `ui.resolve` left it at 2.1.267 and is still a
 * method, served from the `$` client object instead. So the table proves a method
 * exists, but leaving it does not prove a removal. Mentions — method names quoted
 * anywhere else in the bundle — carry the other half: a renamed method
 * (`fs.readFile` -> `fs.read`) vanishes from the bundle entirely, a moved one does
 * not. See modEvidenceFrom and distillModObservations.
 *
 * WHAT IS REJECTED, AND WHY.
 *   - Quoted `"$.ui.toast"` strings, as evidence that a method exists. They are labels
 *     in log, error and permission text, and they disagree with the table in both
 *     directions (`$.process.spawn` is a label but not a key; `$.session.append` is a
 *     key but only appears in a template literal as a label).
 *   - The event-name string array (`[...X, "tool.call", …]`), as evidence for a
 *     METHOD. Every method is also an event, so that array spreads the method list
 *     into itself and cannot tell the two apart. It is the EVENT evidence instead:
 *     see the events section below.
 *   - The event tables. They share the dotted key shape but hold bare handlers,
 *     never `{run}` objects, so the `run` share rules them out.
 *
 * EVENTS. One array literal lists every event name the hooks engine accepts:
 *
 *   2.1.242  Dn=["PreToolUse","tool.call","ui.render", …,"engine.create",...Ct]
 *   2.1.301  ZIe=[...Ve,"tool.call","tool.check", …,"engine.create",...FKn]
 *
 * Each dotted string literal in it is one event. The spreads are not read, and each
 * must be a bare identifier, as every real one is: one is
 * the method list (every method is also an event, and those publish as methods),
 * and from 2.1.265 the other is the settings hook events as `classic.<Name>`. A
 * bare capitalized literal (`PreToolUse`, before 2.1.265) is a settings hook event
 * too, so it is skipped by name shape. Any other element throws, because the array
 * is the whole event list and an element this rule cannot read would publish as a
 * removal. The array is picked by shape: one spread or more, and at least
 * MIN_EVENT_LITERALS dotted literals. If a second array ever has that shape too, the
 * lane throws rather than guess (see modEventsFrom).
 *
 * RENDER SITES. The places a mod can draw, read from a described zod enum and from
 * the `useRenderInput` calls that draw them; see modRenderSitesFrom.
 *
 * ELEMENTS. The element types a `ui.render` tree is built from, read from the
 * per-app element lists; see modElementsFrom.
 *
 * FLOOR. The table first ships in MOD_METHOD_FLOOR; mods were only announced in
 * 2.1.287. At or after the floor, zero tables means the extractor lost the API and
 * throws, because downstream zero methods reads as every method removed at once.
 * Two tables means the rule can no longer tell which is the API, and throws at any
 * version.
 *
 * COST. This lane does no parsing of its own in the cache writers: it reads each
 * chunk's AST through `extractControlMessages`'s `onProgram` callback.
 */
import { collectChildEnvNames } from './child-env.js';
import {
  collectSkillEvidence,
  resolveVariableSkills,
  type SkillEvidence,
  type VariableSkill,
} from './skill-lane.js';
import { compareVersionsAsc } from './lib.js';
import { extractControlMessages, isNode, parse, walk, type Node } from './control-lane.js';

/** First release whose bundle carries the mods API dispatch table. */
export const MOD_METHOD_FLOOR = '2.1.242';

/**
 * The fewest dotted keys a table may have. The real table never had fewer than 35
 * (2.1.242), while 2.1.300 also carries single-key handler registrations such as
 * `{"prompt.compose":{name:"core",run:…}}`, which have the table's shape at one key.
 */
const MIN_TABLE_KEYS = 10;

/** A dispatch-table key: `namespace.method`. */
const METHOD_KEY = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

/**
 * The fewest dotted literals the event array may have. Smaller arrays with a spread,
 * such as `[...X,"turn.step","process.spawn"]`, are other lists of event names.
 */
const MIN_EVENT_LITERALS = 8;

/** A settings hook event written bare, as the 2.1.242 event array writes `PreToolUse`. */
const HOOK_EVENT_NAME = /^[A-Z][A-Za-z]*$/;

/** A render site's name, the value of `e.component` in a `ui.render` hook. */
const RENDER_SITE_NAME = /^[A-Z][A-Za-z]*$/;

/** The text the bundle gives the render-site enum, from RENDER_SITE_ENUM_FLOOR. */
const RENDER_SITE_DESCRIBE = /^(?:@internal )?A component a plugin may draw through `ui\.render`/;

/** An element name, the `type` of a node in a `ui.render` tree: `Box`, and early on `div`. */
const ELEMENT_NAME = /^[A-Za-z]+$/;

/**
 * The fewest distinct elements the per-app lists may hold. They held 5 at 2.1.242 and
 * grow after that, so a smaller object with a `terminal` key is something else.
 */
const MIN_ELEMENTS = 4;

/** First release whose bundle carries the described render-site enum. */
export const RENDER_SITE_ENUM_FLOOR = '2.1.285';

/** A non-computed property key written as a string literal, else undefined. */
function literalKey(property: unknown): string | undefined {
  if (!isNode(property) || property.type !== 'Property' || property.computed === true) {
    return undefined;
  }
  const key = property.key;
  return isNode(key) && key.type === 'Literal' && typeof key.value === 'string'
    ? key.value
    : undefined;
}

function hasRunMember(value: unknown): boolean {
  if (!isNode(value) || value.type !== 'ObjectExpression') return false;
  return (value.properties as unknown[]).some(
    (p) => isNode(p) && p.type === 'Property' && isNode(p.key) && p.key.name === 'run'
  );
}

/** A candidate dispatch table: its method keys, and every property it cannot read. */
export interface ModTable {
  keys: string[];
  /** A spread, a computed key, or a literal key that is not `namespace.method`. */
  unreadable: string[];
}

function describeProperty(property: Node): string {
  if (property.type === 'SpreadElement') return 'a spread';
  if (property.computed === true) return 'a computed key';
  const key = literalKey(property);
  return key === undefined
    ? `a ${String((property.key as Node | undefined)?.type)} key`
    : `key "${key}"`;
}

/** A candidate event array: its event names, and every element it cannot read. */
export interface ModEventArray {
  events: string[];
  /** An element that is neither a spread, a dotted literal, nor a bare hook event name. */
  unreadable: string[];
}

/** One chunk's evidence: its candidate tables and event arrays, and every method-shaped string. */
export interface ModEvidence {
  tables: ModTable[];
  eventArrays: ModEventArray[];
  /** Every string literal, and template literal without substitutions, shaped `ns.method`. */
  names: string[];
  /** Each described render-site enum: its members, and every element it cannot read. */
  siteEnums: Array<{ sites: string[]; unreadable: string[] }>;
  /** The first argument of each `X.useRenderInput` call that is a site name. */
  siteCalls: string[];
  /** A note for each such call whose first argument is not a site name. */
  siteCallsUnreadable: string[];
  /** Each candidate per-app element list object: every element name it holds. */
  elementLists: Array<{ elements: string[]; unreadable: string[] }>;
}

/**
 * The elements of a per-app element list object, or undefined when `node` is not one:
 * `{terminal:["Box","Text",…],desktop:[…],…}`, a `terminal` key, every value an array
 * of string literals, and at least MIN_ELEMENTS distinct names, so a small look-alike
 * such as `{terminal:[]}` is not picked. If a second object ever has that shape too,
 * the lane throws rather than guess.
 */
function elementListsOf(node: Node): { elements: string[]; unreadable: string[] } | undefined {
  const props = node.properties as Node[];
  const keyOf = (p: Node) => (p.key as Node).name ?? (p.key as Node).value;
  if (!props.some((p) => p.type === 'Property' && keyOf(p) === 'terminal')) return undefined;
  const lists = props.every(
    (p) =>
      p.type === 'Property' &&
      (p.value as Node).type === 'ArrayExpression' &&
      ((p.value as Node).elements as Array<Node | null>).every(
        (e) => e?.type === 'Literal' && typeof e.value === 'string'
      )
  );
  if (!lists) return undefined;
  const names = new Set(
    props.flatMap((p) => ((p.value as Node).elements as Node[]).map((e) => String(e.value)))
  );
  if (names.size < MIN_ELEMENTS) return undefined;
  const elements: string[] = [];
  const unreadable: string[] = [];
  for (const p of props) {
    if (p.computed === true) unreadable.push('a computed app key');
    for (const e of (p.value as Node).elements as Node[]) {
      const name = String(e.value);
      if (ELEMENT_NAME.test(name)) elements.push(name);
      else unreadable.push(`"${name}"`);
    }
  }
  return { elements, unreadable };
}

/**
 * The members of a described render-site enum, or undefined when `node` is not one:
 * `B([…]).describe("@internal A component a plugin may draw through `ui.render`…")`.
 */
function siteEnumOf(node: Node): { sites: string[]; unreadable: string[] } | undefined {
  const callee = node.callee as Node;
  const [text] = node.arguments as Node[];
  if (
    callee.type !== 'MemberExpression' ||
    (callee.property as Node).name !== 'describe' ||
    text?.type !== 'Literal' ||
    typeof text.value !== 'string' ||
    !RENDER_SITE_DESCRIBE.test(text.value)
  ) {
    return undefined;
  }
  const inner = callee.object as Node;
  const [list] = inner.type === 'CallExpression' ? (inner.arguments as Node[]) : [];
  if (list?.type !== 'ArrayExpression') {
    return { sites: [], unreadable: [`an enum built from a ${String(list?.type ?? inner.type)}`] };
  }
  const sites: string[] = [];
  const unreadable: string[] = [];
  for (const element of list.elements as Array<Node | null>) {
    if (
      element?.type === 'Literal' &&
      typeof element.value === 'string' &&
      RENDER_SITE_NAME.test(element.value)
    ) {
      sites.push(element.value);
    } else unreadable.push(element === null ? 'a hole' : `a ${element.type}`);
  }
  return { sites, unreadable };
}

/** The event array's reading of one array literal, or undefined when it is not a candidate. */
function eventArrayOf(node: Node): ModEventArray | undefined {
  const events: string[] = [];
  const unreadable: string[] = [];
  let spreads = 0;
  for (const element of node.elements as Array<Node | null>) {
    if (element?.type === 'SpreadElement') {
      spreads += 1;
      // Every real spread names a list bound elsewhere (the methods, the classic
      // events). An inlined array or a conditional could carry events the rule never
      // reads, so it is refused rather than skipped.
      const argument = element.argument as Node;
      if (argument.type !== 'Identifier') unreadable.push(`a spread of a ${argument.type}`);
    } else if (element?.type === 'Literal' && typeof element.value === 'string') {
      if (METHOD_KEY.test(element.value)) events.push(element.value);
      else if (!HOOK_EVENT_NAME.test(element.value)) unreadable.push(`"${element.value}"`);
    } else unreadable.push(element === null ? 'a hole' : `a ${element.type}`);
  }
  return spreads > 0 && events.length >= MIN_EVENT_LITERALS ? { events, unreadable } : undefined;
}

function stringValue(node: Node): string | undefined {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type !== 'TemplateLiteral' || (node.expressions as unknown[]).length !== 0)
    return undefined;
  const cooked = ((node.quasis as Node[])[0]?.value as { cooked?: unknown } | undefined)?.cooked;
  return typeof cooked === 'string' ? cooked : undefined;
}

/**
 * One walk over `program` for both kinds of evidence. A table is an object literal
 * with at least MIN_TABLE_KEYS dotted keys, at least half of them `{run}` objects.
 * Selection ignores the properties it cannot read; modEvidenceFrom refuses them in
 * the table it picks.
 */
export function collectModEvidence(program: Node): ModEvidence {
  const tables: ModTable[] = [];
  const eventArrays: ModEventArray[] = [];
  const names: string[] = [];
  const siteEnums: ModEvidence['siteEnums'] = [];
  const siteCalls: string[] = [];
  const siteCallsUnreadable: string[] = [];
  const elementLists: ModEvidence['elementLists'] = [];
  walk(program, (node) => {
    const value = stringValue(node);
    if (value !== undefined && METHOD_KEY.test(value)) names.push(value);
    if (node.type === 'CallExpression') {
      const siteEnum = siteEnumOf(node);
      if (siteEnum) siteEnums.push(siteEnum);
      const callee = node.callee as Node;
      if (
        callee.type === 'MemberExpression' &&
        (callee.property as Node).name === 'useRenderInput'
      ) {
        const [site] = node.arguments as Node[];
        if (
          site?.type === 'Literal' &&
          typeof site.value === 'string' &&
          RENDER_SITE_NAME.test(site.value)
        ) {
          siteCalls.push(site.value);
        } else siteCallsUnreadable.push(`a ${String(site?.type ?? 'missing')} argument`);
      }
      return;
    }
    if (node.type === 'ArrayExpression') {
      const array = eventArrayOf(node);
      if (array) eventArrays.push(array);
      return;
    }
    if (node.type !== 'ObjectExpression') return;
    const elementList = elementListsOf(node);
    if (elementList) elementLists.push(elementList);
    const keys: string[] = [];
    const unreadable: string[] = [];
    let runs = 0;
    for (const property of node.properties as Node[]) {
      const key = literalKey(property);
      if (key === undefined || !METHOD_KEY.test(key)) {
        unreadable.push(describeProperty(property));
        continue;
      }
      keys.push(key);
      if (hasRunMember(property.value)) runs += 1;
    }
    if (keys.length >= MIN_TABLE_KEYS && runs * 2 >= keys.length) tables.push({ keys, unreadable });
  });
  return { tables, eventArrays, names, siteEnums, siteCalls, siteCallsUnreadable, elementLists };
}

/**
 * The elements one release lists, sorted: the union of the per-app element lists, the
 * apps a `ui.render` tree can draw in. The object is the whole list, so leaving it is
 * a removal: `div`, `span` and `b` leave at 2.1.267. It ships with the method table, so
 * it shares MOD_METHOD_FLOOR: below it the lane asserts nothing, and from it zero or
 * two objects throw. Per-app support is not published; it varies by version.
 */
export function modElementsFrom(evidence: readonly ModEvidence[], version: string): string[] {
  if (compareVersionsAsc(version, MOD_METHOD_FLOOR) < 0) return [];
  const lists = evidence.flatMap((chunk) => chunk.elementLists);
  if (lists.length > 1) {
    throw new Error(
      `mod lane: ${version} has ${lists.length} objects that look like the per-app element ` +
        'lists. The rule can no longer tell which one it is; read the bundle and tighten ' +
        'elementListsOf.'
    );
  }
  if (lists.length === 0) {
    throw new Error(
      `mod lane: ${version} has no per-app element lists, and every release since ` +
        `${MOD_METHOD_FLOOR} has them. Refusing to report zero elements, which would read ` +
        'as every element removed at once.'
    );
  }
  const [list] = lists as [ModEvidence['elementLists'][number]];
  if (list.unreadable.length > 0) {
    throw new Error(
      `mod lane: ${version}'s element lists hold ${list.unreadable.join(', ')}, which this ` +
        'lane cannot read as an element. Read the bundle and teach elementListsOf the new shape.'
    );
  }
  return [...new Set(list.elements)].sort();
}

/**
 * The render sites one release proves, sorted, and whether its render-site enum was
 * read (`listed`). Two constructs, because neither covers every era:
 *
 *   - From RENDER_SITE_ENUM_FLOOR, a zod enum the bundle describes as "A component a
 *     plugin may draw through `ui.render`". It is the whole list, so leaving it is
 *     removal evidence, and it must be present.
 *   - From MOD_METHOD_FLOOR, the first argument of each `X.useRenderInput("<Site>", …)`
 *     member call, the hook that draws a site. A call proves a site exists and dates
 *     it, but these calls are not the whole list. Some chunks call the hook through a
 *     bare name imported from the chunk that exports it, and such names are reused by
 *     unrelated helpers elsewhere, so those calls are not read. From 2.1.269 that is how
 *     `AbovePrompt` and `Pane` are drawn. So absence from the calls proves nothing:
 *     distillModRenderSiteObservations takes removals only from releases where
 *     `listed` is true.
 *
 * Below MOD_METHOD_FLOOR the lane asserts nothing.
 */
export function modRenderSitesFrom(
  evidence: readonly ModEvidence[],
  version: string
): { sites: string[]; listed: boolean } {
  if (compareVersionsAsc(version, MOD_METHOD_FLOOR) < 0) return { sites: [], listed: false };
  const enums = evidence.flatMap((chunk) => chunk.siteEnums);
  const calls = evidence.flatMap((chunk) => chunk.siteCalls);
  const unreadable = [
    ...evidence
      .flatMap((chunk) => chunk.siteCallsUnreadable)
      .map((n) => `useRenderInput with ${n}`),
    ...enums.flatMap((e) => e.unreadable).map((n) => `the render-site enum holding ${n}`),
  ];
  if (enums.length > 1) {
    throw new Error(
      `mod lane: ${version} has ${enums.length} described render-site enums. The rule ` +
        'can no longer tell which one is the list; read the bundle and tighten siteEnumOf.'
    );
  }
  if (unreadable.length > 0) {
    throw new Error(
      `mod lane: ${version} has ${unreadable.join(', ')}, which this lane cannot read as a ` +
        'render site. Read the bundle and teach collectModEvidence the new shape.'
    );
  }
  const listed = enums.length === 1;
  if (!listed && compareVersionsAsc(version, RENDER_SITE_ENUM_FLOOR) >= 0) {
    throw new Error(
      `mod lane: ${version} has no described render-site enum, and every release since ` +
        `${RENDER_SITE_ENUM_FLOOR} has one. Refusing to report its sites from the ` +
        'useRenderInput calls alone, which would read as removals.'
    );
  }
  if (!listed && calls.length === 0) {
    throw new Error(
      `mod lane: ${version} has neither a render-site enum nor a useRenderInput call, and ` +
        `every release since ${MOD_METHOD_FLOOR} has one or the other.`
    );
  }
  return { sites: [...new Set([...calls, ...(enums[0]?.sites ?? [])])].sort(), listed };
}

/**
 * The events one release's event array lists, sorted. The array ships with the
 * method table, so it shares MOD_METHOD_FLOOR and its refusals.
 */
export function modEventsFrom(evidence: readonly ModEvidence[], version: string): string[] {
  // Below the floor the lane asserts nothing: the shape is weaker than the method
  // table's, and an older array that happened to match would date events before the
  // mods API existed.
  if (compareVersionsAsc(version, MOD_METHOD_FLOOR) < 0) return [];
  const arrays = evidence.flatMap((chunk) => chunk.eventArrays);
  if (arrays.length > 1) {
    throw new Error(
      `mod lane: ${version} has ${arrays.length} arrays that look like the mods event ` +
        'list. The rule can no longer tell which one is the list; read the bundle and ' +
        'tighten eventArrayOf.'
    );
  }
  if (arrays.length === 0) {
    throw new Error(
      `mod lane: ${version} has no mods event list, and every release since ` +
        `${MOD_METHOD_FLOOR} has one. Refusing to report zero events, which would read ` +
        'as every event removed at once.'
    );
  }
  const [array] = arrays as [ModEventArray];
  if (array.unreadable.length > 0) {
    throw new Error(
      `mod lane: ${version}'s mods event list holds ${array.unreadable.join(', ')}, which ` +
        'this lane cannot read as an event. Read the bundle and teach eventArrayOf the ' +
        'new shape.'
    );
  }
  return [...new Set(array.events)].sort();
}

/**
 * The `$.`-prefixed methods one release's table proves, and its mentions: method
 * names quoted elsewhere in the bundle whose namespace is a table namespace but
 * which are not table keys. Both sorted.
 *
 * A mention is not evidence a method exists. It is what keeps one that LEFT the
 * table from reading as removed: `ui.resolve` moved out of the table at 2.1.267 and
 * is still a method, still quoted in every later bundle. The cost runs the other
 * way: a method dropped while a same-named event stays keeps being mentioned, so it
 * reads as live. That is the conservative error, a missed removal rather than a
 * false one; the measured renames (`fs.readFile` -> `fs.read`) vanish entirely.
 */
export function modEvidenceFrom(
  evidence: readonly ModEvidence[],
  version: string
): { methods: string[]; mentions: string[] } {
  const tables = evidence.flatMap((chunk) => chunk.tables);
  if (tables.length > 1) {
    throw new Error(
      `mod lane: ${version} has ${tables.length} tables that look like the mods API ` +
        'dispatch table. The rule can no longer tell which one is the API; read the ' +
        'bundle and tighten collectModEvidence.'
    );
  }
  if (tables.length === 0) {
    if (compareVersionsAsc(version, MOD_METHOD_FLOOR) < 0) return { methods: [], mentions: [] };
    throw new Error(
      `mod lane: ${version} has no mods API dispatch table, and every release since ` +
        `${MOD_METHOD_FLOOR} has one. Refusing to report zero methods, which would read ` +
        'as every method removed at once.'
    );
  }
  const [table] = tables as [ModTable];
  // Absence from the table is half of the removal evidence, so a method this rule
  // cannot read must stop the run rather than publish as removed.
  if (table.unreadable.length > 0) {
    throw new Error(
      `mod lane: ${version}'s mods API dispatch table holds ${table.unreadable.join(', ')}, ` +
        'which this lane cannot read as a method. Read the bundle and teach ' +
        'collectModEvidence the new shape.'
    );
  }
  const keys = new Set(table.keys);
  const namespaces = new Set(table.keys.map((key) => key.slice(0, key.indexOf('.'))));
  const mentions = new Set(
    evidence
      .flatMap((chunk) => chunk.names)
      .filter((name) => !keys.has(name) && namespaces.has(name.slice(0, name.indexOf('.'))))
  );
  const prefixed = (set: Set<string>) => [...set].map((key) => `$.${key}`).sort();
  return { methods: prefixed(keys), mentions: prefixed(mentions) };
}

/**
 * Parses and extracts in one call, for tests and archive sweeps. The cache writers
 * do not use this: they collect evidence through `extractControlMessages`'s
 * `onProgram`, so each chunk is parsed once.
 */
export function extractModEvidence(
  source: string | readonly string[],
  version: string
): { methods: string[]; mentions: string[] } {
  const evidence = (typeof source === 'string' ? [source] : source).map((src) =>
    collectModEvidence(parse(src))
  );
  return modEvidenceFrom(evidence, version);
}

/** The methods alone; see extractModEvidence. */
export const extractModMethods = (source: string | readonly string[], version: string): string[] =>
  extractModEvidence(source, version).methods;

/** The events alone, parsing each chunk; see extractModEvidence. */
export const extractModEvents = (source: string | readonly string[], version: string): string[] =>
  modEventsFrom(
    (typeof source === 'string' ? [source] : source).map((src) => collectModEvidence(parse(src))),
    version
  );

/** The render sites alone, parsing each chunk; see modRenderSitesFrom. */
export const extractModRenderSites = (
  source: string | readonly string[],
  version: string
): { sites: string[]; listed: boolean } =>
  modRenderSitesFrom(
    (typeof source === 'string' ? [source] : source).map((src) => collectModEvidence(parse(src))),
    version
  );

/** The elements alone, parsing each chunk; see modElementsFrom. */
export const extractModElements = (source: string | readonly string[], version: string): string[] =>
  modElementsFrom(
    (typeof source === 'string' ? [source] : source).map((src) => collectModEvidence(parse(src))),
    version
  );

/** Runs both AST lanes over one parse of each chunk. */
export function extractControlAndModMethods(
  source: string | readonly string[],
  version: string
): {
  controlMessages: ReturnType<typeof extractControlMessages>;
  modMethods: string[];
  modMentions: string[];
  modEvents: string[];
  modRenderSites: string[];
  modRenderSitesListed: boolean;
  modElements: string[];
  /** Env var names Claude Code sets for a child process; see child-env.ts. */
  childEnvVars: string[];
  /** Skills registered under a variable name; see skill-lane.ts. */
  variableSkills: VariableSkill[];
} {
  const evidence: ModEvidence[] = [];
  const childEnv = new Set<string>();
  const skills: SkillEvidence[] = [];
  const controlMessages = extractControlMessages(source, version, (program) => {
    evidence.push(collectModEvidence(program));
    for (const name of collectChildEnvNames(program)) childEnv.add(name);
    skills.push(collectSkillEvidence(program));
  });
  const { methods, mentions } = modEvidenceFrom(evidence, version);
  const { sites, listed } = modRenderSitesFrom(evidence, version);
  return {
    controlMessages,
    modMethods: methods,
    modMentions: mentions,
    modEvents: modEventsFrom(evidence, version),
    modRenderSites: sites,
    modRenderSitesListed: listed,
    modElements: modElementsFrom(evidence, version),
    childEnvVars: [...childEnv].sort(),
    variableSkills: resolveVariableSkills(skills),
  };
}
