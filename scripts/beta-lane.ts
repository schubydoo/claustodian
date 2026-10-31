// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — the `anthropic-beta` header values Claude Code can send
 * (`fast-mode-2026-02-01`, `context-1m-2025-08-07`).
 *
 * THE HEADER IS THE IDENTITY. From BETA_FLOOR the bundle registers each beta through
 * one factory, which pairs an internal name with the header value:
 *
 *   2.1.124  function iZ(H,$){return Object.freeze({name:H,header:$})}
 *   2.1.316  KPt=k("speed","fast-mode-2026-02-01"),yv=k("long_context","context-1m-2025-08-07")
 *
 * The header is what the CLI sends and what the API documents, so it is the symbol.
 * One name can register two headers (`tool_search`), and a re-dated beta keeps its name
 * while its header changes, which reads as the old header removed and the new one added:
 * that is what the CLI does. The name becomes the description. A beta with no header
 * (`{name:e,header:null}`, from another factory) sends nothing and is not read.
 *
 * WHICH CALLS. The factory's local name changes with every build and every chunk (`iZ`,
 * `H`, `k`), and those short names also belong to unrelated functions in other scopes:
 * `H("tengu_daemon_control",{…})`. So a call counts only when its callee resolves, by
 * lexical scope, to the factory's own declaration, or from 2.1.242 to an import of the
 * chunk that exports it. A header written as a variable resolves the same way
 * (`k("oauth_auth",jc)`). A factory call whose header this lane cannot read throws.
 *
 * FLOORS. Below BETA_FLOOR the lane asserts nothing. From it, fewer than
 * MIN_BETA_HEADERS headers throws, because downstream a short list reads as betas
 * removed. Two factories also throw: the rule could no longer tell which is the registry.
 *
 * COST. This lane does no parsing of its own in the cache writers: it reads each chunk's
 * AST through `extractControlMessages`'s `onProgram` callback, as the mod lane does.
 */
import { compareVersionsAsc } from './lib.js';
import { importOrExportName, isNode, parse, type Node } from './control-lane.js';
import { lookup, walkScopes, type Binding, type Scope } from './js-scope.js';

/** First release whose bundle registers betas through the factory. */
export const BETA_FLOOR = '2.1.124';

/** The fewest headers a release from BETA_FLOOR may register. It had 17 there. */
const MIN_BETA_HEADERS = 12;

/** A beta header value: `fast-mode-2026-02-01`, `x-cc-internal-mid-conv-cache-promotion`. */
const HEADER = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/** A registry name: `speed`, `long_context`. */
const NAME = /^[a-z][a-z0-9_]*$/;

/** One header a release registers, with every name it is registered under. */
export interface BetaObservation {
  header: string;
  names: string[];
}

interface Call {
  callee: string;
  scope: Scope;
  name: Node;
  header: Node;
}

/** One chunk's evidence. Names resolve only once every chunk is known. */
export interface BetaEvidence {
  root: Scope;
  /** The binding of each factory declaration in this chunk. */
  factories: Set<Binding>;
  calls: Call[];
  /** Imported names, by module path. */
  importNames: Map<string, Set<string>>;
  /** Exported name to local name. */
  exports: Map<string, string>;
}

/** True when `fn` is `function f(a,b){return Object.freeze({name:a,header:b})}`. */
function isFactory(fn: Node): boolean {
  const params = fn.params as Node[];
  const body = (fn.body as Node).body as Node[];
  const ret = body.length === 1 && body[0]?.type === 'ReturnStatement' ? body[0] : undefined;
  const call = ret?.argument as Node | undefined;
  const callee = call?.callee as Node | undefined;
  const [object] = (call?.arguments as Node[] | undefined) ?? [];
  if (
    params.length !== 2 ||
    params.some((p) => p.type !== 'Identifier') ||
    callee?.type !== 'MemberExpression' ||
    (callee.object as Node).name !== 'Object' ||
    (callee.property as Node).name !== 'freeze' ||
    object?.type !== 'ObjectExpression'
  ) {
    return false;
  }
  const props = object.properties as Node[];
  const valueOf = (key: string) =>
    props.find((p) => p.type === 'Property' && (p.key as Node).name === key)?.value as
      Node | undefined;
  return (
    props.length === 2 &&
    valueOf('name')?.name === (params[0] as Node).name &&
    valueOf('header')?.name === (params[1] as Node).name
  );
}

/** One walk over `program` for the factory, its calls, and the chunk's imports and exports. */
export function collectBetaEvidence(program: Node): BetaEvidence {
  const declarations: Array<{ name: string; scope: Scope }> = [];
  const calls: Call[] = [];
  const importNames = new Map<string, Set<string>>();
  const exports = new Map<string, string>();
  const root = walkScopes(program, (node, scope) => {
    if (node.type === 'FunctionDeclaration' && isNode(node.id) && isFactory(node)) {
      declarations.push({ name: node.id.name as string, scope });
      return;
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee as Node;
      const args = node.arguments as Node[];
      const [name, header] = args;
      if (
        callee.type === 'Identifier' &&
        args.length === 2 &&
        name?.type === 'Literal' &&
        typeof name.value === 'string' &&
        NAME.test(name.value) &&
        header
      ) {
        calls.push({ callee: callee.name as string, scope, name, header });
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
    if (node.type === 'ExportNamedDeclaration' && node.source == null) {
      for (const spec of node.specifiers as Node[]) {
        exports.set(importOrExportName(spec.exported), importOrExportName(spec.local));
      }
    }
  });
  const factories = new Set<Binding>();
  for (const { name, scope } of declarations) {
    const binding = lookup(name, scope);
    if (binding) factories.add(binding);
  }
  return { root, factories, calls, importNames, exports };
}

/** The headers one release registers, sorted. See the module comment for the rules. */
export function betasFrom(chunks: readonly BetaEvidence[], version: string): BetaObservation[] {
  if (compareVersionsAsc(version, BETA_FLOOR) < 0) return [];
  const factoryCount = chunks.reduce((n, chunk) => n + chunk.factories.size, 0);
  if (factoryCount > 1) {
    throw new Error(
      `beta lane: ${version} has ${factoryCount} beta factories. The rule can no longer ` +
        'tell which one is the registry; read the bundle and tighten isFactory.'
    );
  }
  // A module path resolves only when exactly one chunk exports every name imported
  // from it, as in the skill and control lanes.
  const namesBySource = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    for (const [source, names] of chunk.importNames) {
      const all = namesBySource.get(source) ?? new Set<string>();
      for (const n of names) all.add(n);
      namesBySource.set(source, all);
    }
  }
  const chunkBySource = new Map<string, BetaEvidence>();
  for (const [source, names] of namesBySource) {
    const matches = chunks.filter((c) => [...names].every((n) => c.exports.has(n)));
    if (matches.length === 1) chunkBySource.set(source, matches[0] as BetaEvidence);
  }
  /** The binding a name resolves to, following one import to the exporting chunk. */
  const resolve = (
    chunk: BetaEvidence,
    name: string,
    scope: Scope
  ): { chunk: BetaEvidence; binding: Binding } | undefined => {
    const binding = lookup(name, scope);
    if (!binding?.imported) return binding ? { chunk, binding } : undefined;
    const owner = chunkBySource.get(binding.imported.source);
    const local = owner?.exports.get(binding.imported.name);
    const target = owner && local !== undefined ? lookup(local, owner.root) : undefined;
    return owner && target && !target.imported ? { chunk: owner, binding: target } : undefined;
  };
  const stringOf = (chunk: BetaEvidence, value: Node, scope: Scope): string | undefined => {
    if (value.type === 'Literal') return typeof value.value === 'string' ? value.value : undefined;
    if (value.type !== 'Identifier') return undefined;
    const found = resolve(chunk, value.name as string, scope);
    const init = found?.binding.init;
    return found && isNode(init) ? stringOf(found.chunk, init, found.binding.scope) : undefined;
  };

  const headers = new Map<string, Set<string>>();
  const unreadable: string[] = [];
  for (const chunk of chunks) {
    for (const call of chunk.calls) {
      const target = resolve(chunk, call.callee, call.scope);
      if (!target || !target.chunk.factories.has(target.binding)) continue;
      const header = stringOf(chunk, call.header, call.scope);
      if (header === undefined || !HEADER.test(header)) {
        unreadable.push(`the header of "${String(call.name.value)}" (a ${call.header.type})`);
        continue;
      }
      const names = headers.get(header) ?? new Set<string>();
      names.add(call.name.value as string);
      headers.set(header, names);
    }
  }
  if (unreadable.length > 0) {
    throw new Error(
      `beta lane: ${version} registers ${unreadable.join(', ')}, which this lane cannot ` +
        'read as a header. Read the bundle and teach betasFrom the new shape.'
    );
  }
  if (headers.size < MIN_BETA_HEADERS) {
    throw new Error(
      `beta lane: ${version} registers ${headers.size} beta headers, and every release ` +
        `since ${BETA_FLOOR} registers at least ${MIN_BETA_HEADERS}. Refusing to report a ` +
        'short list, which would read as betas removed.'
    );
  }
  return [...headers]
    .map(([header, names]) => ({ header, names: [...names].sort() }))
    .sort((a, b) => (a.header < b.header ? -1 : 1));
}

/** Parses and extracts in one call, for tests and archive sweeps; see betasFrom. */
export const extractBetas = (
  source: string | readonly string[],
  version: string
): BetaObservation[] =>
  betasFrom(
    (typeof source === 'string' ? [source] : source).map((src) => collectBetaEvidence(parse(src))),
    version
  );
