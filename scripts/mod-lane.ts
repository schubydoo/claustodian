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
 *   - The event-name string array (`[...X, "tool.call", …]`). Every method is also
 *     an event, so that array mixes the two families and asserts neither alone.
 *   - The event tables. They share the dotted key shape but hold bare handlers,
 *     never `{run}` objects, so the `run` share rules them out.
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

/** One chunk's evidence: its candidate tables, and every method-shaped string. */
export interface ModEvidence {
  tables: ModTable[];
  /** Every string literal, and template literal without substitutions, shaped `ns.method`. */
  names: string[];
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
  const names: string[] = [];
  walk(program, (node) => {
    const value = stringValue(node);
    if (value !== undefined && METHOD_KEY.test(value)) names.push(value);
    if (node.type !== 'ObjectExpression') return;
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
  return { tables, names };
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

/** Runs both AST lanes over one parse of each chunk. */
export function extractControlAndModMethods(
  source: string | readonly string[],
  version: string
): {
  controlMessages: ReturnType<typeof extractControlMessages>;
  modMethods: string[];
  modMentions: string[];
} {
  const evidence: ModEvidence[] = [];
  const controlMessages = extractControlMessages(source, version, (program) =>
    evidence.push(collectModEvidence(program))
  );
  const { methods, mentions } = modEvidenceFrom(evidence, version);
  return { controlMessages, modMethods: methods, modMentions: mentions };
}
