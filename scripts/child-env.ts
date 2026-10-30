// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — env vars that Claude Code SETS for a child process.
 *
 * The other env rules prove a name by a READ: `process.env.NAME`, the typed
 * registry, an accessor getter, a reader helper. A name that Claude Code only
 * writes into a child's environment has no read, so none of them can see it. The
 * self-hosted runner is the clear case: it hands `CLAUDE_RUNNER_SESSION_ID`,
 * `CLAUDE_RUNNER_EXIT_REASON` and others to the wrapper script and to its hooks,
 * and the docs page that lists them was the only evidence the dataset had.
 *
 * THE KEY IS THE EVIDENCE. The bundle builds the child's environment as an object
 * literal and passes it as a spawn option:
 *
 *   let n={...ie(),...e.gitEnvironment?.envOverrides,CLAUDE_RUNNER_SESSION_ID:…};
 *   …on(e.hookPath,[],{cwd:e.cwd,env:an(e.gitConfigPins?.length?gEs(n):n,…)})
 *
 * A key of an object that reaches an `env` option is a variable in that child's
 * environment, so it is an env var by construction. Whose variable it is, is a
 * separate question: the runner also sets `GIT_TERMINAL_PROMPT` and `TZ`.
 * Publication answers that with its usual gate (isPublishableBinaryEnv), so a name
 * from this rule is recorded either way and published only when it is Claude
 * Code's own.
 *
 * HOW AN OBJECT REACHES THE OPTION. An env site is a property named `env`, or one
 * whose camelCase name ends in `Env` (`enforcedEnv`, `extendEnv`): the session
 * runner passes its object as `La({inheritedEnv:process.env,enforcedEnv:Zn})` and
 * hands the result to `{env:Pe}`. From the site's value the walk follows only the
 * parts that can carry the environment itself: an object literal's KEYS, its
 * spreads, both arms of `?:`, both sides of `&&`/`||`/`??`, call arguments, and a
 * variable, through up to ENV_FLOW_HOPS declarations in scope. It never reads a
 * property VALUE or the object of a member access, because those carry data, not
 * the environment: `CLAUDE_CODE_VERSION:{README_URL:…}` is one variable whose value
 * is an object, and `O.classes.FormData` is not an environment at all.
 *
 * Names are resolved by scope, not by spelling. From 2.1.242 every chunk minifies
 * its own names, and inside a chunk `n` is a different variable in each function,
 * so a variable resolves to its declaration in the nearest enclosing function.
 *
 * This rule is additive. Leaving an object it read does not prove a removal; the
 * text-confirmed removal check (computeTextRemoval) decides that.
 */

import { isNode, type Node } from './control-lane.js';

/** How many declarations the walk follows from an env site to an object literal. */
export const ENV_FLOW_HOPS = 3;

const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
const ENV_SITE = /^(?:env|[a-z][A-Za-z0-9]*Env)$/;
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** A property's key as written, or undefined for a computed key or a spread. */
function keyName(p: Node): string | undefined {
  if (p.type !== 'Property' || p.computed) return undefined;
  const key = p.key as Node;
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/**
 * The parts of an expression that can carry an environment: the object literals
 * it builds (with their spreads) and the variables that can hold one.
 */
function envParts(x: unknown, ids: Set<string>, objects: Node[]): void {
  /* v8 ignore next -- every caller passes an expression node; the guard only narrows the type */
  if (!isNode(x)) return;
  switch (x.type) {
    case 'Identifier':
      ids.add(x.name as string);
      return;
    case 'ObjectExpression':
      objects.push(x);
      for (const p of x.properties as Node[]) {
        if (p.type === 'SpreadElement') envParts(p.argument, ids, objects);
      }
      return;
    case 'ConditionalExpression':
      envParts(x.consequent, ids, objects);
      envParts(x.alternate, ids, objects);
      return;
    case 'LogicalExpression':
      envParts(x.left, ids, objects);
      envParts(x.right, ids, objects);
      return;
    case 'CallExpression':
      for (const a of x.arguments as Node[]) {
        envParts(a.type === 'SpreadElement' ? a.argument : a, ids, objects);
      }
      return;
    case 'SequenceExpression':
      envParts((x.expressions as Node[]).at(-1), ids, objects);
      return;
    case 'ParenthesizedExpression':
      envParts(x.expression, ids, objects);
      return;
    case 'AwaitExpression':
      envParts(x.argument, ids, objects);
      return;
  }
}

/** One function's own declarations and env sites, with nested functions set apart. */
function collectScope(fn: Node): { decls: Map<string, unknown>; sites: unknown[]; nested: Node[] } {
  const decls = new Map<string, unknown>();
  const sites: unknown[] = [];
  const nested: Node[] = [];
  const visit = (n: unknown, top: boolean): void => {
    if (Array.isArray(n)) {
      for (const c of n) visit(c, top);
      return;
    }
    if (!isNode(n)) return;
    if (!top && FUNCTION_TYPES.has(n.type)) {
      nested.push(n);
      return;
    }
    if (n.type === 'VariableDeclarator') {
      const id = n.id as Node;
      if (id.type === 'Identifier' && n.init) decls.set(id.name as string, n.init);
    }
    if (n.type === 'Property') {
      const name = keyName(n);
      if (name !== undefined && ENV_SITE.test(name)) sites.push(n.value);
    }
    for (const key in n) {
      const v = n[key];
      if (typeof v === 'object' && v !== null) visit(v, false);
    }
  };
  visit(fn, true);
  return { decls, sites, nested };
}

/**
 * Every ALL-CAPS key of an object literal that reaches an env site in `program`.
 * A program is one chunk, or the whole bundle before the code-split era.
 */
export function collectChildEnvNames(program: Node): Set<string> {
  const out = new Set<string>();
  const addKeys = (o: Node): void => {
    for (const p of o.properties as Node[]) {
      const name = keyName(p);
      if (name !== undefined && ENV_NAME.test(name)) out.add(name);
    }
  };
  const scan = (fn: Node, outer: readonly Map<string, unknown>[]): void => {
    const { decls, sites, nested } = collectScope(fn);
    const chain = [decls, ...outer];
    for (const site of sites) {
      let frontier: unknown[] = [site];
      const seen = new Set<string>();
      for (let hop = 0; hop <= ENV_FLOW_HOPS && frontier.length > 0; hop++) {
        const next: unknown[] = [];
        for (const expr of frontier) {
          const ids = new Set<string>();
          const objects: Node[] = [];
          envParts(expr, ids, objects);
          for (const o of objects) addKeys(o);
          for (const id of ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            const scope = chain.find((m) => m.has(id));
            if (scope) next.push(scope.get(id));
          }
        }
        frontier = next;
      }
    }
    for (const f of nested) scan(f, chain);
  };
  scan(program, []);
  return out;
}
