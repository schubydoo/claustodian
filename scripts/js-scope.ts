// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Lexical scopes for the AST lanes that resolve a variable to its declaration
 * (child-env.ts, skill-lane.ts, model-lane.ts, beta-lane.ts).
 *
 * Minified code reuses short names in every function and often in every block, and
 * from 2.1.242 each chunk minifies its own names. So a name resolves to the nearest
 * binding that is visible where it is used, never by spelling alone:
 *
 *   - a block, `for`, `switch` or `catch` opens a scope for `let`, `const`, `class`
 *     and the `catch` parameter;
 *   - a function or the program also takes `var`, function names and parameters;
 *   - an `import` binds its local name in the program scope.
 *
 * A binding with no value to follow (a parameter, a destructured name, a declaration
 * with no initialiser, a class) still hides an outer name of the same spelling, and
 * its `init` is null. A repeated `var n;` declares nothing new, so `n` keeps the
 * value it already has.
 */

import { importOrExportName, isNode, type Node } from './control-lane.js';

/** A name's binding: its initial value (or null) and the scope that value is written in. */
export interface Binding {
  init: unknown;
  scope: Scope;
  /** Set for an `import{name as local}from"source"` binding. */
  imported?: { source: string; name: string };
}

export interface Scope {
  bindings: Map<string, Binding>;
  parent: Scope | null;
  /** True for a function or the program, where `var` and function names bind. */
  hoists: boolean;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const BLOCK_TYPES = new Set([
  'BlockStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
  'CatchClause',
]);

const newScope = (parent: Scope | null, hoists: boolean): Scope => ({
  bindings: new Map(),
  parent,
  hoists,
});

/** The nearest binding of `name` visible from `scope`, or undefined for a global. */
export function lookup(name: string, scope: Scope): Binding | undefined {
  for (let s: Scope | null = scope; s; s = s.parent) {
    const b = s.bindings.get(name);
    if (b) return b;
  }
  return undefined;
}

/** Every name a binding pattern declares: `a`, `{a,b:c}`, `[a,...d]`, `a=1`. */
export function patternNames(p: unknown, out: string[]): string[] {
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

/**
 * Walks `program`, building its scopes, and calls `visit` for every node with the
 * scope that node is evaluated in. Returns the program scope. Bindings are complete
 * only once the walk ends, so resolve names after it, not inside `visit`.
 */
export function walkScopes(program: Node, visit: (node: Node, scope: Scope) => void): Scope {
  const root = newScope(null, true);
  const step = (n: unknown, scope: Scope): void => {
    if (Array.isArray(n)) {
      for (const c of n) step(c, scope);
      return;
    }
    if (!isNode(n)) return;
    visit(n, scope);
    if (FUNCTION_TYPES.has(n.type)) {
      if (n.type === 'FunctionDeclaration' && n.id) bindAll(hoistTarget(scope), n.id);
      const inner = newScope(scope, true);
      // A function expression's own name is visible only inside it.
      if (n.type === 'FunctionExpression' && n.id) bindAll(inner, n.id);
      for (const param of n.params as unknown[]) bindAll(inner, param);
      step(n.params, inner);
      const body = n.body as Node;
      step(body.type === 'BlockStatement' ? body.body : body, inner);
      return;
    }
    let here = scope;
    if (BLOCK_TYPES.has(n.type)) {
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
    if (n.type === 'ImportDeclaration') {
      const source = importOrExportName(n.source);
      for (const spec of n.specifiers as Node[]) {
        const local = importOrExportName(spec.local);
        root.bindings.set(local, {
          init: null,
          scope: root,
          ...(spec.type === 'ImportSpecifier'
            ? { imported: { source, name: importOrExportName(spec.imported) } }
            : {}),
        });
      }
    }
    for (const key in n) {
      const v = n[key];
      if (typeof v === 'object' && v !== null) step(v, here);
    }
  };
  step(program.body, root);
  return root;
}
