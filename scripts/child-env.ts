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
 * Names are resolved by lexical scope, not by spelling. From 2.1.242 every chunk
 * minifies its own names, and inside a chunk `n` is a different variable in each
 * function and often in each block. So a variable resolves to the nearest binding
 * that is visible where it is used: a block's `let` or `const`, a function's `var`,
 * parameter or function name, or a `catch` parameter. A binding with no object to
 * follow (a parameter, a destructured name, a declaration with no initialiser)
 * still hides an outer one of the same name, and yields nothing. A later
 * assignment (`n={…}` after `let n;`) is not followed either. That can only miss a
 * name, never invent one, which is the safe direction for an additive rule.
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

/** A name's binding: the expression it starts with (or null), and the scope that expression is written in. */
interface Binding {
  init: unknown;
  scope: Scope;
}

interface Scope {
  bindings: Map<string, Binding>;
  parent: Scope | null;
  /** True for a function or the program, where `var` and function names bind. */
  hoists: boolean;
}

const newScope = (parent: Scope | null, hoists: boolean): Scope => ({
  bindings: new Map(),
  parent,
  hoists,
});

/** The nearest binding of `name` visible from `scope`, or undefined for a global. */
function lookup(name: string, scope: Scope): Binding | undefined {
  for (let s: Scope | null = scope; s; s = s.parent) {
    const b = s.bindings.get(name);
    if (b) return b;
  }
  return undefined;
}

/** Every name a binding pattern declares: `a`, `{a,b:c}`, `[a,...d]`, `a=1`. */
function patternNames(p: unknown, out: string[]): string[] {
  if (!isNode(p)) return out;
  if (p.type === 'Identifier') out.push(p.name as string);
  else if (p.type === 'ObjectPattern') {
    for (const prop of p.properties as Node[]) {
      patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
    }
  } else if (p.type === 'ArrayPattern')
    for (const e of p.elements as unknown[]) patternNames(e, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  // RestElement, the only other binding pattern a declaration can hold.
  else patternNames(p.argument, out);
  return out;
}

const bindAll = (scope: Scope, pattern: unknown): void => {
  for (const name of patternNames(pattern, [])) scope.bindings.set(name, { init: null, scope });
};

const hoistTarget = (scope: Scope): Scope => {
  let s = scope;
  while (!s.hoists && s.parent) s = s.parent;
  return s;
};

/** Every env site in `program`, each with the scope its value is read in. */
function collectSites(program: Node): { value: unknown; scope: Scope }[] {
  const sites: { value: unknown; scope: Scope }[] = [];
  const visit = (n: unknown, scope: Scope): void => {
    if (Array.isArray(n)) {
      for (const c of n) visit(c, scope);
      return;
    }
    if (!isNode(n)) return;
    if (FUNCTION_TYPES.has(n.type)) {
      if (n.type === 'FunctionDeclaration' && n.id) bindAll(hoistTarget(scope), n.id);
      const inner = newScope(scope, true);
      // A function expression's own name is visible only inside it.
      if (n.type === 'FunctionExpression' && n.id) bindAll(inner, n.id);
      for (const param of n.params as unknown[]) bindAll(inner, param);
      visit(n.params, inner);
      const body = n.body as Node;
      visit(body.type === 'BlockStatement' ? body.body : body, inner);
      return;
    }
    let here = scope;
    if (
      n.type === 'BlockStatement' ||
      n.type === 'ForStatement' ||
      n.type === 'ForInStatement' ||
      n.type === 'ForOfStatement' ||
      n.type === 'SwitchStatement' ||
      n.type === 'CatchClause'
    ) {
      here = newScope(scope, false);
      if (n.type === 'CatchClause') bindAll(here, n.param);
    }
    if (n.type === 'VariableDeclaration') {
      const target = n.kind === 'var' ? hoistTarget(here) : here;
      for (const d of n.declarations as Node[]) {
        const id = d.id as Node;
        if (id.type === 'Identifier') {
          // A repeated `var n;` declares nothing new: `n` keeps the value it has.
          if (n.kind === 'var' && !d.init && target.bindings.has(id.name as string)) continue;
          target.bindings.set(id.name as string, { init: d.init ?? null, scope: here });
        } else bindAll(target, id);
      }
    }
    if (n.type === 'ClassDeclaration' && n.id) bindAll(here, n.id);
    if (n.type === 'Property') {
      const name = keyName(n);
      if (name !== undefined && ENV_SITE.test(name)) sites.push({ value: n.value, scope: here });
    }
    for (const key in n) {
      const v = n[key];
      if (typeof v === 'object' && v !== null) visit(v, here);
    }
  };
  visit(program.body, newScope(null, true));
  return sites;
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
  for (const site of collectSites(program)) {
    // Each step holds an expression and the scope its names resolve in. A name in a
    // declaration's initialiser resolves where that declaration is, not at the site.
    let frontier = [{ expr: site.value, scope: site.scope }];
    const seen = new Set<Binding>();
    for (let hop = 0; hop <= ENV_FLOW_HOPS && frontier.length > 0; hop++) {
      const next: typeof frontier = [];
      for (const { expr, scope } of frontier) {
        const ids = new Set<string>();
        const objects: Node[] = [];
        envParts(expr, ids, objects);
        for (const o of objects) addKeys(o);
        for (const id of ids) {
          const binding = lookup(id, scope);
          if (!binding || binding.init === null || seen.has(binding)) continue;
          seen.add(binding);
          next.push({ expr: binding.init, scope: binding.scope });
        }
      }
      frontier = next;
    }
  }
  return out;
}
