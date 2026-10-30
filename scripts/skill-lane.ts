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
 * RESOLVING THE NAME. The identifier resolves by lexical scope (js-scope.ts), to
 * the binding that is visible at the object, and that binding must hold one string
 * literal:
 *   - a declaration `X="literal"`, with no assignment or update to that same binding
 *     that could change it;
 *   - or an import, followed to the one chunk that exports every name imported from
 *     that path (the fingerprint the control lane uses, since a chunk carries no name
 *     of its own), then to that chunk's top-level binding, under the same rule.
 * A parameter or a destructured name resolves to nothing, and so does a global.
 * The object must also not be able to replace its `name`: a second `name` key, or
 * a spread or computed key after it, rejects the entry. Anything else is a miss,
 * never a guess. The name must also fit the skill grammar (`[a-z][a-z0-9-]+`).
 *
 * This lane is additive. A name the literal rule finds keeps its evidence and its
 * description; see withVariableSkills.
 */

import { importOrExportName, isNode, type Node } from './control-lane.js';
import { lookup, patternNames, walkScopes, type Binding, type Scope } from './js-scope.js';

const SKILL_NAME = /^[a-z][a-z0-9-]+$/;

/** One variable-named skill entry, before its name is resolved. */
interface Entry {
  ref: string;
  scope: Scope;
  description: string | undefined;
  aliases: string[];
}

/** What one chunk contributes; see collectSkillEvidence. */
export interface SkillEvidence {
  entries: Entry[];
  /** The chunk's top-level scope, which its imports and exports bind in. */
  root: Scope;
  /** Bindings an assignment or update may change, so they hold no single literal. */
  written: Set<Binding>;
  /** Module path → the export names this chunk imports from it. */
  importNames: Map<string, Set<string>>;
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

/** True when no later key of the object can replace the `name` at `index`. */
function nameIsFinal(props: Node[], index: number): boolean {
  return props.every((p, i) => {
    if (i === index) return true;
    if (keyName(p) === 'name') return false;
    return i < index || (p.type !== 'SpreadElement' && !p.computed);
  });
}

/** Every variable-named skill entry, write, import and export in one chunk. */
export function collectSkillEvidence(program: Node): SkillEvidence {
  const entries: Entry[] = [];
  const writes: { name: string; scope: Scope; value: string | undefined }[] = [];
  const importNames = new Map<string, Set<string>>();
  const exports = new Map<string, string>();
  const root = walkScopes(program, (node, scope) => {
    if (node.type === 'ObjectExpression') {
      const props = node.properties as Node[];
      const index = props.findIndex((p) => keyName(p) === 'name' && p.kind === 'init');
      const value = props[index]?.value as Node | undefined;
      if (value?.type !== 'Identifier' || !nameIsFinal(props, index)) return;
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
      entries.push({
        ref: value.name as string,
        scope,
        description: entryDescription(props),
        aliases,
      });
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const left = node.left as Node;
      if (left.type === 'Identifier') {
        const value = node.operator === '=' ? staticString(node.right) : undefined;
        writes.push({ name: left.name as string, scope, value });
      } else {
        // `({n}=o)` or `[n]=a` writes every name of the pattern.
        for (const name of patternNames(left, [])) writes.push({ name, scope, value: undefined });
      }
      return;
    }
    // `for(n of xs)` and `for(n in o)` write to a variable declared elsewhere.
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      const left = node.left as Node;
      if (left.type !== 'VariableDeclaration') {
        for (const name of patternNames(left, [])) writes.push({ name, scope, value: undefined });
      }
    }
    if (node.type === 'UpdateExpression') {
      const target = node.argument as Node;
      if (target.type === 'Identifier') {
        writes.push({ name: target.name as string, scope, value: undefined });
      }
      return;
    }
    if (node.type === 'ImportDeclaration') {
      const source = importOrExportName(node.source);
      for (const spec of node.specifiers as Node[]) {
        if (spec.type !== 'ImportSpecifier') continue;
        const names = importNames.get(source) ?? new Set<string>();
        names.add(importOrExportName(spec.imported));
        importNames.set(source, names);
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
  // A write leaves a binding with one literal only when it writes that same literal.
  const written = new Set<Binding>();
  for (const { name, scope, value } of writes) {
    const binding = lookup(name, scope);
    if (binding && (value === undefined || staticString(binding.init) !== value)) {
      written.add(binding);
    }
  }
  return { entries, root, written, importNames, exports };
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
    for (const [source, names] of chunk.importNames) {
      const all = namesBySource.get(source) ?? new Set<string>();
      for (const n of names) all.add(n);
      namesBySource.set(source, all);
    }
  }
  const chunkBySource = new Map<string, SkillEvidence>();
  for (const [source, names] of namesBySource) {
    const matches = chunks.filter((c) => [...names].every((n) => c.exports.has(n)));
    if (matches.length === 1) chunkBySource.set(source, matches[0] as SkillEvidence);
  }
  const literal = (chunk: SkillEvidence, binding: Binding | undefined): string | undefined => {
    if (!binding || chunk.written.has(binding)) return undefined;
    const value = staticString(binding.init);
    return value !== undefined && SKILL_NAME.test(value) ? value : undefined;
  };
  const resolve = (chunk: SkillEvidence, entry: Entry): string | undefined => {
    const binding = lookup(entry.ref, entry.scope);
    if (!binding?.imported) return literal(chunk, binding);
    const owner = chunkBySource.get(binding.imported.source);
    const local = owner?.exports.get(binding.imported.name);
    // An export of an import (`import{a}…;export{a}`) is not followed further.
    const target = owner && local !== undefined ? lookup(local, owner.root) : undefined;
    return target?.imported ? undefined : literal(owner as SkillEvidence, target);
  };

  const names = new Map<string, string | undefined>();
  const aliases = new Set<string>();
  for (const chunk of chunks) {
    for (const entry of chunk.entries) {
      const name = resolve(chunk, entry);
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
