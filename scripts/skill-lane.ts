// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — skills whose `name:` is a variable, not a literal.
 *
 * The skill registry rule in extract-bundle.ts (extractSkillCommands) reads
 * `name:"loop"` beside a `menuDescription:` or `whenToUse:` marker. From about
 * 2.1.232 several skills register with a variable instead:
 *
 *   2.1.232  var Skt="loop";…{name:Skt,menuDescription:"Repeat a prompt…",aliases:["proactive"]}
 *   2.1.314  chunk A: …Moi="setup-claude"…export{…,Moi,…}
 *            chunk B: import{Moi}from"/$bunfs/root/chunk-ppgjwzdp.js";…{name:Moi,aliases:["setup-cowork"],menuDescription:…}
 *
 * A literal rule cannot see either, so the skill and every alias on it were lost:
 * `/schedule` and `/loop` from 2.1.232, `/setup-claude` and `/explain-usage` later.
 *
 * THE OBJECT IS THE EVIDENCE, AS BEFORE. An entry is an object literal with a `name`
 * property whose value is an identifier, and a `menuDescription` or `whenToUse`
 * property: the same marker the literal rule needs. Only the name moves.
 *
 * RESOLVING THE NAME. The identifier must resolve to one string literal:
 *   - in its own chunk, a declaration `X="literal"` that no other declaration or
 *     assignment in that chunk contradicts;
 *   - or an import, followed to the one chunk that exports every name imported from
 *     that path (the fingerprint the control lane uses, since a chunk carries no name
 *     of its own), then to that chunk's local binding, under the same rule.
 * Anything else resolves to nothing: a name the lane cannot prove is a miss, never a
 * guess. The name must also fit the skill grammar (`[a-z][a-z0-9-]+`).
 *
 * This lane is additive. A name the literal rule finds keeps its evidence and its
 * description; see withVariableSkills.
 */

import { importOrExportName, isNode, walk, type Node } from './control-lane.js';

const SKILL_NAME = /^[a-z][a-z0-9-]+$/;

/** One variable-named skill entry, before its name is resolved. */
interface Entry {
  ref: string;
  description: string | undefined;
  aliases: string[];
}

/** What one chunk contributes; see collectSkillEvidence. */
export interface SkillEvidence {
  entries: Entry[];
  /** Local name → its string literal, or null when the chunk binds it to anything else. */
  strings: Map<string, string | null>;
  /** Local name → the module path and export it was imported as. */
  imports: Map<string, { source: string; name: string }>;
  /** Export name → the local it publishes. */
  exports: Map<string, string>;
}

/** A resolved skill: its `/name`, its description, and whether it is an alias. */
export interface VariableSkill {
  symbol: string;
  description?: string;
  alias: boolean;
}

/** A property's key as written, or undefined for a computed key or a spread. */
function keyName(p: Node): string | undefined {
  if (p.type !== 'Property' || p.computed) return undefined;
  const key = p.key as Node;
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/** A static string: a string literal, or a template literal with no `${…}`. */
function staticString(n: unknown): string | undefined {
  if (!isNode(n)) return undefined;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && (n.expressions as unknown[]).length === 0) {
    // An untagged template has no invalid escape, so its `cooked` text is always set.
    return ((n.quasis as Node[])[0]?.value as { cooked: string }).cooked;
  }
  return undefined;
}

/**
 * The description an entry carries, in the literal rule's order: `menuDescription`,
 * then `description`, then a `get description(){return "…"}` getter.
 */
function entryDescription(props: Node[]): string | undefined {
  const byKey = (k: string) => props.find((p) => keyName(p) === k && p.kind === 'init');
  const menu = staticString(byKey('menuDescription')?.value);
  if (menu !== undefined) return menu;
  const plain = staticString(byKey('description')?.value);
  if (plain !== undefined) return plain;
  const getter = props.find((p) => keyName(p) === 'description' && p.kind === 'get');
  const body = ((getter?.value as Node | undefined)?.body as Node | undefined)?.body as
    Node[] | undefined;
  const ret = body?.length === 1 && body[0]?.type === 'ReturnStatement' ? body[0] : undefined;
  return staticString(ret?.argument);
}

/** Every variable-named skill entry, string binding, import and export in one chunk. */
export function collectSkillEvidence(program: Node): SkillEvidence {
  const entries: Entry[] = [];
  const strings = new Map<string, string | null>();
  const imports = new Map<string, { source: string; name: string }>();
  const exports = new Map<string, string>();
  const bind = (name: string, value: string | null): void => {
    const known = strings.get(name);
    strings.set(name, known === undefined || known === value ? value : null);
  };
  walk(program, (node) => {
    if (node.type === 'ObjectExpression') {
      const props = (node.properties as Node[]).filter((p) => p.type === 'Property');
      const name = props.find((p) => keyName(p) === 'name' && p.kind === 'init');
      const value = name?.value as Node | undefined;
      if (value?.type !== 'Identifier') return;
      const marked = props.some((p) => {
        const k = keyName(p);
        return k === 'menuDescription' || k === 'whenToUse';
      });
      if (!marked) return;
      const list = props.find((p) => keyName(p) === 'aliases')?.value as Node | undefined;
      const aliases =
        list?.type === 'ArrayExpression'
          ? (list.elements as unknown[])
              .map(staticString)
              .filter((a): a is string => a !== undefined && SKILL_NAME.test(a))
          : [];
      entries.push({ ref: value.name as string, description: entryDescription(props), aliases });
      return;
    }
    if (node.type === 'VariableDeclarator') {
      const id = node.id as Node;
      if (id.type !== 'Identifier') return;
      const name = id.name as string;
      if (node.init == null) return;
      bind(name, staticString(node.init) ?? null);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const left = node.left as Node;
      if (left.type !== 'Identifier') return;
      bind(left.name as string, node.operator === '=' ? (staticString(node.right) ?? null) : null);
      return;
    }
    if (node.type === 'ImportDeclaration') {
      const source = importOrExportName(node.source);
      for (const spec of node.specifiers as Node[]) {
        if (spec.type !== 'ImportSpecifier') continue;
        imports.set(importOrExportName(spec.local), {
          source,
          name: importOrExportName(spec.imported),
        });
      }
      return;
    }
    // A re-export facade (`export{X}from"m"`) publishes another module's name, so it
    // must not fingerprint this chunk as that name's source.
    if (node.type === 'ExportNamedDeclaration' && node.source == null) {
      for (const spec of node.specifiers as Node[]) {
        exports.set(importOrExportName(spec.exported), importOrExportName(spec.local));
      }
    }
  });
  return { entries, strings, imports, exports };
}

/**
 * Resolves every chunk's entries to skill names, across chunks where an entry's name
 * is imported. See the file header for the rules.
 */
export function resolveVariableSkills(chunks: readonly SkillEvidence[]): VariableSkill[] {
  // A module path resolves only when exactly one chunk exports every name imported
  // from it, as in the control lane.
  const namesBySource = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    for (const { source, name } of chunk.imports.values()) {
      const names = namesBySource.get(source) ?? new Set<string>();
      names.add(name);
      namesBySource.set(source, names);
    }
  }
  const chunkBySource = new Map<string, SkillEvidence>();
  for (const [source, names] of namesBySource) {
    const matches = chunks.filter((c) => [...names].every((n) => c.exports.has(n)));
    if (matches.length === 1) chunkBySource.set(source, matches[0] as SkillEvidence);
  }
  const literal = (value: string | null | undefined): string | undefined =>
    value != null && SKILL_NAME.test(value) ? value : undefined;
  const resolve = (chunk: SkillEvidence, ref: string): string | undefined => {
    if (chunk.strings.has(ref)) return literal(chunk.strings.get(ref));
    const imported = chunk.imports.get(ref);
    if (!imported) return undefined;
    const owner = chunkBySource.get(imported.source);
    const local = owner?.exports.get(imported.name);
    return owner && local !== undefined ? literal(owner.strings.get(local)) : undefined;
  };

  const names = new Map<string, string | undefined>();
  const aliases = new Set<string>();
  for (const chunk of chunks) {
    for (const entry of chunk.entries) {
      const name = resolve(chunk, entry.ref);
      if (name === undefined) continue;
      const key = `/${name}`;
      if (!names.has(key) || (names.get(key) === undefined && entry.description)) {
        names.set(key, entry.description);
      }
      for (const alias of entry.aliases) aliases.add(`/${alias}`);
    }
  }
  const out: VariableSkill[] = [];
  for (const [symbol, description] of names) {
    out.push({ symbol, alias: false, ...(description ? { description } : {}) });
  }
  for (const symbol of aliases) if (!names.has(symbol)) out.push({ symbol, alias: true });
  // Each symbol is listed once, so no two compare equal.
  return out.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
}
