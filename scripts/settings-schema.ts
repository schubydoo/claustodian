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
 * From 2.1.284 the ROOT is also emitted as a returned plain object of thunks,
 * `return{cleanupPeriodDays:()=>lt().int(),…}`, which a lazy wrapper builds field
 * by field. The walk reads each value past its thunk (see `readValue`); nested
 * objects are still call-opened.
 *
 * A third change, at 2.1.242, is not an emission era but a SCOPE one: the
 * bundle became a graph of ES-module chunks, each with its own minified names.
 * The walk takes the chunk list and resolves every reference inside the chunk
 * that binds it (see `Scope`); the emission rules above are unchanged.
 *
 * HARD-FAIL, NEVER SHRINK. Every failure path throws rather than returning a
 * partial set. A settings schema that is present but only partly walked is
 * indistinguishable, downstream, from keys being deleted upstream — and a
 * shrunken set is exactly how the research prototype invented phantom
 * `sandbox.filesystem.*` removals at 2.1.203 and 2.1.210. A version with no
 * schema at all (before 0.2.123) is a different answer and returns empty.
 */

import {
  parseSync,
  type ArrayExpressionElement,
  type Expression,
  type ExpressionStatement,
  type Function as FunctionNode,
  type ParenthesizedExpression,
  type FunctionBody,
  type ReturnStatement,
  type ArrowFunctionExpression,
  type Statement,
} from 'oxc-parser';

/**
 * Long-lived top-level keys used to locate the schema root. Several, because a
 * single anchor is one upstream rename away from silently disabling the lane.
 * `cleanupPeriodDays` has been present since 0.2.123, `includeCoAuthoredBy`
 * since 1.0.x (now deprecated but still emitted), `apiKeyHelper` since 0.2.x.
 */
const ANCHOR_KEYS = ['cleanupPeriodDays', 'includeCoAuthoredBy', 'apiKeyHelper'] as const;

/**
 * An anchor key followed by a call — `key:v.number(` (namespaced) or `key:lt(`
 * (tree-shaken), optionally behind a thunk — `key:()=>k(` (2.1.284 →). Group 1
 * is the namespace alias when there is one, so the namespaced era can still
 * report a real zod type.
 */
const ANCHOR_RE = new RegExp(
  `(?:${ANCHOR_KEYS.join('|')}):(?:\\(\\)=>)?(?:([A-Za-z_$][\\w$]*)\\.)?[A-Za-z_$][\\w$]*\\(`
);

/** What a local name is bound to, as far as the walk can tell. */
type Binding =
  /** Bound to this expression; `shift` maps its offsets back into the bundle. */
  | { node: Expression; shift: number }
  /** Declared with no initializer and never assigned: it holds no schema. */
  | 'unknown'
  /** Bound by a destructuring pattern, whose value the walk cannot read. */
  | 'destructured'
  /** Assigned again after it was bound, so its value at the use is not known. */
  | 'reassigned';

/** Local names in scope for a value. */
type Locals = ReadonlyMap<string, Binding>;

const NO_LOCALS: Locals = new Map();

/** A value read through the parser: its schema expression and what it can see. */
interface ReadValue {
  /** Span of the value past any thunk, which its own description is read from. */
  valueStart: number;
  valueEnd: number;
  /** Span of the expression whose keys are the value's keys, past any `lazy`. */
  childStart: number;
  childEnd: number;
  /** Where the value's own description starts when a `lazy` call precedes it. */
  tail?: number;
  /**
   * The members to read keys from, and the offset just past the call that holds
   * them: a union's array, or a single local name standing for the schema.
   */
  union?: { members: ArrayExpressionElement[]; end: number; shift: number };
  /** Names in scope: the enclosing ones, plus a block thunk's own declarations. */
  locals: Locals;
}

/**
 * Reads one value through the parser.
 *
 * The value must parse as exactly one expression. `scanLevel` bounds each value
 * by counting brackets and quotes and does not know regex literals, so a regex
 * holding a bracket or quote (`/\\(/`) moves the bound and swallows the keys after
 * it without an error. A value that is not one expression is that failure, and
 * it throws.
 *
 * From 2.1.284 the root is a plain object of thunks —
 * `{apiKeyHelper:()=>o().optional(),…}` — which a lazy wrapper (`new yn(la(e))`)
 * builds field by field. The schema is what follows the arrow. A block-bodied
 * thunk (`()=>{let i=u({…});return Fe([H(),i])…}`) holds its schema in the
 * block's top-level `return`. Reading the whole block instead hands the parent
 * its first child's `.describe()`: `attribution` borrowed `attribution.commit`'s
 * sentence at 2.1.284. Only a straight-line block with exactly one top-level
 * `return` is read. A second return, or a branch or loop that could hide one
 * (`if(e){return a}return b`), throws rather than walking one branch and
 * dropping the other's keys.
 *
 * From 2.1.281 `permissions` and `sandbox` are zod `lazy` schemas —
 * `permissions:Oe(()=>ji(e)).describe(…)`, where `Oe` builds
 * `{type:"lazy",getter:…}` — so their keys are the keys of what the getter
 * returns. A call whose only argument is a thunk is read that way. Resolving the
 * callee instead reached the lazy builder, which is not an object, and dropped
 * all 48 `permissions.*` and `sandbox.*` keys.
 *
 * A union passed its members as an array literal (`Fe([H(),i],{…})…`) is
 * reported with its members, so the walk can read them.
 */
function readValue(
  src: string,
  entryStart: number,
  entryEnd: number,
  path: string,
  inherited: Locals
): ReadValue {
  // The newline keeps a trailing `//` comment from swallowing the closing paren.
  const parsed = parseSync('value.js', `(${src.slice(entryStart, entryEnd)}\n)`, {
    sourceType: 'script',
  });
  const statement = parsed.program.body[0];
  if (
    parsed.errors.length > 0 ||
    parsed.program.body.length !== 1 ||
    statement?.type !== 'ExpressionStatement' ||
    statement.expression.type !== 'ParenthesizedExpression' ||
    statement.expression.expression.type === 'SequenceExpression'
  ) {
    throw new SettingsSchemaError(
      `settings schema: the value of "${path}" is not one expression, so its ` +
        `extent was misread. Refusing to emit a key set that may be missing its keys.`
    );
  }
  const shift = entryStart - 1;
  let schema: Expression = statement.expression.expression;
  let valueStart = entryStart;
  let valueEnd = entryEnd;
  let locals = inherited;
  const thunk = thunkBody(schema, path, shift);
  if (thunk) {
    schema = thunk.expression;
    valueStart = schema.start + shift;
    if (thunk.block) valueEnd = schema.end + shift;
    locals = new Map([...inherited, ...thunk.locals]);
  }
  let childStart = valueStart;
  let childEnd = valueEnd;
  let tail: number | undefined;
  for (let lazy = lazyGetter(schema); lazy; lazy = lazyGetter(schema)) {
    tail ??= lazy.call.end + shift;
    const inner = thunkBody(lazy.getter, path, shift) as NonNullable<ReturnType<typeof thunkBody>>;
    schema = inner.expression;
    childStart = schema.start + shift;
    childEnd = schema.end + shift;
    locals = new Map([...locals, ...inner.locals]);
  }
  const base = chainBase(schema);
  const array = base.type === 'CallExpression' ? base.arguments[0] : undefined;
  let union: ReadValue['union'];
  if (
    base.type === 'CallExpression' &&
    base.callee.type === 'Identifier' &&
    array?.type === 'ArrayExpression' &&
    array.elements.some((m) => carriesKeys(m, locals))
  ) {
    union = { members: array.elements, end: base.end + shift, shift };
  } else if (base.type === 'Identifier' && locals.has(base.name)) {
    // A local name (`return i`, `i.optional()`) is read like a one-member union,
    // through its binding, since the plain path resolves only called names.
    union = { members: [schema], end: base.end + shift, shift };
  }
  return { valueStart, valueEnd, childStart, childEnd, tail, union, locals };
}

/**
 * The expression a zero-parameter arrow evaluates to, with the locals its block
 * declares, or `undefined` for anything else.
 */
function thunkBody(
  node: Expression,
  path: string,
  shift: number
): { expression: Expression; block: boolean; locals: Map<string, Binding> } | undefined {
  if (node.type !== 'ArrowFunctionExpression' || node.params.length !== 0 || node.async)
    return undefined;
  // An expression-bodied arrow's body is the expression itself in this tree.
  if (node.expression)
    return { expression: node.body as Expression, block: false, locals: new Map() };
  const body = node.body as FunctionBody;
  return {
    expression: blockReturn(body, path),
    block: true,
    locals: declaredLocals(body.body, shift),
  };
}

/** `X(()=>…)`: a call whose only argument is a thunk, and that thunk. */
function lazyGetter(node: Expression): { call: Expression; getter: Expression } | undefined {
  const base = chainBase(node);
  if (base.type !== 'CallExpression' || base.callee.type !== 'Identifier') return undefined;
  const [getter, ...rest] = base.arguments;
  if (rest.length > 0 || getter?.type !== 'ArrowFunctionExpression') return undefined;
  if (getter.params.length !== 0 || getter.async) return undefined;
  return { call: base, getter };
}

/** The call at the base of a method chain: `u({…})` in `u({…}).passthrough().optional()`. */
function chainBase(node: Expression): Expression {
  let base = node;
  while (base.type === 'CallExpression' && base.callee.type === 'MemberExpression')
    base = base.callee.object;
  return base;
}

/** The object literal a member's base call takes as its first argument, if any. */
function objectArgument(member: Expression): { start: number } | undefined {
  const base = chainBase(member);
  if (base.type !== 'CallExpression') return undefined;
  const first = base.arguments[0];
  return first?.type === 'ObjectExpression' ? first : undefined;
}

/**
 * Whether a union member can carry keys: an inline object call, a local name in
 * scope, or a call to a named factory. A string or a name the value cannot see
 * cannot, so an enum over strings or module constants (`$([cD,"high"])`) is not
 * read as a union and keeps the plain path.
 */
function carriesKeys(member: ArrayExpressionElement, locals: Locals): boolean {
  if (!member || member.type === 'SpreadElement') return false;
  const base = chainBase(member);
  if (base.type === 'Identifier') return locals.has(base.name);
  return base.type === 'CallExpression' && base.callee.type === 'Identifier';
}

/** The argument of a straight-line block's single top-level `return`, or throws. */
function blockReturn(body: FunctionBody, path: string): Expression {
  const refuse = (why: string): never => {
    throw new SettingsSchemaError(
      `settings schema: the thunk for "${path}" has a block body ${why}. ` +
        `Refusing to emit a key set that may be missing its keys.`
    );
  };
  const returns = body.body.filter((node) => node.type === 'ReturnStatement');
  if (returns.length === 0) refuse('with no top-level return');
  if (returns.length > 1) refuse('with more than one top-level return');
  for (const node of body.body) {
    if (
      node.type !== 'ReturnStatement' &&
      node.type !== 'VariableDeclaration' &&
      node.type !== 'ExpressionStatement'
    )
      refuse(`with a top-level ${node.type}`);
  }
  const ret = returns[0] as ReturnStatement;
  if (ret !== body.body.at(-1)) refuse('with a statement after its return');
  if (!ret.argument) return refuse('whose return has no value');
  return ret.argument;
}

type AnyNode = { type: string } & Record<string, unknown>;

function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** The child nodes of `n`, in source order. */
function childNodes(n: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key in n) {
    /* v8 ignore next -- oxc sets no `parent` links by default; the guard keeps a version that does from recursing forever */
    if (key === 'parent') continue;
    const value = n[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) out.push(child);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * The names a binding or assignment target writes, read by its structure. A
 * property write (`e.i=…`) and an object pattern's keys (`{i:q}`) bind nothing
 * of their own, so neither counts as a write to a local `i`.
 */
function bindingNames(target: unknown, out: string[] = []): string[] {
  if (!isNode(target)) return out;
  if (target.type === 'Identifier') out.push(target.name as string);
  else if (target.type === 'ArrayPattern')
    for (const element of target.elements as unknown[]) bindingNames(element, out);
  else if (target.type === 'ObjectPattern')
    for (const property of target.properties as AnyNode[])
      bindingNames(property.type === 'RestElement' ? property.argument : property.value, out);
  else if (target.type === 'AssignmentPattern') bindingNames(target.left, out);
  else if (target.type === 'RestElement') bindingNames(target.argument, out);
  return out;
}

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** The names a statement list's own `let`, `const`, class and function declarations bind. */
function lexicalNames(statements: unknown): string[] {
  const out: string[] = [];
  // An expression-bodied arrow has no statement list, so it declares nothing.
  for (const node of (Array.isArray(statements) ? statements : []) as AnyNode[]) {
    if (node.type === 'VariableDeclaration' && node.kind !== 'var')
      for (const declarator of node.declarations as AnyNode[]) bindingNames(declarator.id, out);
    else if (
      (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
      isNode(node.id)
    )
      out.push(node.id.name as string);
  }
  return out;
}

/**
 * The names `var` declares anywhere under `node`, not crossing into a nested
 * function or class static block, each of which is its own `var` scope.
 */
function varNames(node: AnyNode, out: string[] = []): string[] {
  for (const child of childNodes(node)) {
    if (FUNCTION_NODES.has(child.type) || child.type === 'StaticBlock') continue;
    if (child.type === 'VariableDeclaration' && child.kind === 'var')
      for (const declarator of child.declarations as AnyNode[]) bindingNames(declarator.id, out);
    varNames(child, out);
  }
  return out;
}

/**
 * Calls `write` for every write under `node` to a name `shadow` does not hide.
 * A nested function's name, parameters and declarations, a class expression's
 * name, a class static block's declarations, a block's or a `switch` body's
 * `let`, `const`, class and function declarations, a loop's own `let` and a
 * catch parameter all hide the outer name, so
 * `(i)=>{i=…}` and `for(let i=0;;i++)` do not write to an outer `i`. A `var`
 * redeclared in a nested block of the same function does, since it is the same
 * binding. `top` holds the declarations being bound, which are not writes.
 */
function eachWrite(
  node: AnyNode,
  shadow: ReadonlySet<string>,
  top: readonly unknown[],
  write: (name: string) => void
): void {
  const hidden: string[] = [];
  if (FUNCTION_NODES.has(node.type)) {
    // A function expression's own name is bound inside it, not outside.
    if (node.type === 'FunctionExpression') bindingNames(node.id, hidden);
    for (const param of node.params as unknown[]) bindingNames(param, hidden);
    const body = node.body as AnyNode;
    varNames(body, hidden);
    hidden.push(...lexicalNames(body.body));
  } else if (node.type === 'ClassExpression') {
    bindingNames(node.id, hidden);
  } else if (node.type === 'StaticBlock') {
    varNames(node, hidden);
    hidden.push(...lexicalNames(node.body));
  } else if (node.type === 'BlockStatement') {
    hidden.push(...lexicalNames(node.body));
  } else if (node.type === 'SwitchStatement') {
    // The cases share one block scope.
    hidden.push(
      ...lexicalNames((node.cases as AnyNode[]).flatMap((c) => c.consequent as unknown[]))
    );
  } else if (node.type === 'CatchClause') {
    bindingNames(node.param, hidden);
  } else if (/^For(?:In|Of)?Statement$/.test(node.type)) {
    const head = node.type === 'ForStatement' ? node.init : node.left;
    if (isNode(head) && head.type === 'VariableDeclaration' && head.kind !== 'var')
      for (const declarator of head.declarations as AnyNode[]) bindingNames(declarator.id, hidden);
  }
  const inner = hidden.length > 0 ? new Set([...shadow, ...hidden]) : shadow;
  const emit = (names: string[]): void => {
    for (const name of names) if (!inner.has(name)) write(name);
  };
  if (node.type === 'AssignmentExpression') emit(bindingNames(node.left));
  // `for(i of e)` writes `i` on every pass without an assignment expression.
  else if (
    (node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
    isNode(node.left) &&
    node.left.type !== 'VariableDeclaration'
  )
    emit(bindingNames(node.left));
  else if (node.type === 'UpdateExpression') emit(bindingNames(node.argument));
  else if (node.type === 'VariableDeclaration' && node.kind === 'var' && !top.includes(node))
    for (const declarator of node.declarations as AnyNode[]) emit(bindingNames(declarator.id));
  // A switch discriminant runs before its cases' scope exists, so the outer
  // names are what it writes.
  for (const child of childNodes(node))
    eachWrite(
      child,
      node.type === 'SwitchStatement' && child === node.discriminant ? shadow : inner,
      top,
      write
    );
}

/**
 * The names the top-level declarations in `statements` bind.
 *
 * A name is `reassigned` when anything in `statements` assigns it again, at any
 * depth: `e&&(i=u({…}))` is how esbuild writes `if(e)i=…`, so a top-level scan
 * alone would follow the first initializer and publish the wrong object's keys.
 * A nested `var` of the same name counts too, since it is the same binding. The
 * one exception is esbuild's hoisting shape, `var i;…;i=u({…})`: a name declared
 * without an initializer and then assigned exactly once, by a top-level
 * statement, is bound to that assignment.
 */
function declaredLocals(statements: readonly Statement[], shift: number): Map<string, Binding> {
  const out = new Map<string, Binding>();
  for (const node of statements) {
    if (node.type !== 'VariableDeclaration') continue;
    for (const declarator of node.declarations) {
      if (declarator.id.type !== 'Identifier') {
        for (const name of bindingNames(declarator.id)) out.set(name, 'destructured');
        continue;
      }
      out.set(declarator.id.name, declarator.init ? { node: declarator.init, shift } : 'unknown');
    }
  }
  const writes = new Map<string, number>();
  const topLevel = new Map<string, Expression>();
  const count = (name: string): void => {
    writes.set(name, (writes.get(name) ?? 0) + 1);
  };
  for (const node of statements) {
    const assignment =
      node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression'
        ? node.expression
        : undefined;
    if (assignment?.operator === '=' && assignment.left.type === 'Identifier')
      topLevel.set(assignment.left.name, assignment.right);
  }
  for (const node of statements)
    eachWrite(node as unknown as AnyNode, new Set(), statements, count);
  for (const [name, binding] of out) {
    const n = writes.get(name) ?? 0;
    if (n === 0) continue;
    const hoisted = topLevel.get(name);
    out.set(
      name,
      binding === 'unknown' && n === 1 && hoisted ? { node: hoisted, shift } : 'reassigned'
    );
  }
  return out;
}

/**
 * The locals the schema ROOT can see: the top-level declarations of the block
 * that holds the `return` returning it. From 2.1.281 that block declares the
 * object member of `attribution`'s union —
 * `let r=(d,c)=>…,i=u({commit:…}).passthrough();return u({$schema:…`.
 *
 * The block is found by parsing, not by searching for the name. Its opening
 * brace is the nearest `{` before the `return` whose text up to the `return`
 * parses as a list of statements: a nearer brace belongs to an object or a
 * nested function that closes before the `return`, and leaves an unmatched
 * bracket. Names declared in an outer block are not seen, so a member bound
 * there throws rather than resolving. A root with no `return` before it
 * (`Q=v.object({…`) sees no locals.
 */
function rootLocals(src: string, root: number): Locals {
  const before = src.slice(Math.max(0, root - 96), root - 1);
  const ret = /(?<![\w$.])return\s*(?:(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\()?$/.exec(before);
  if (!ret) return NO_LOCALS;
  const returnAt = root - 1 - before.length + ret.index;
  const prefix = '(function(){';
  const floor = Math.max(0, returnAt - BLOCK_WINDOW);
  // Each attempt parses from its brace to the `return`, so the attempts are
  // capped: the real roots settle within a handful of braces.
  for (
    let brace = src.lastIndexOf('{', returnAt), tries = 0;
    brace >= floor && tries < BLOCK_TRIES;
    brace = src.lastIndexOf('{', brace - 1), tries++
  ) {
    const text = `${prefix}${src.slice(brace + 1, returnAt)}\nreturn 0})`;
    const parsed = parseSync('block.js', text, { sourceType: 'script' });
    if (parsed.errors.length > 0) continue;
    const fn = (parsed.program.body[0] as ExpressionStatement)
      .expression as ParenthesizedExpression;
    const body = (fn.expression as FunctionNode).body as FunctionBody;
    return declaredLocals(body.body, brace + 1 - prefix.length);
  }
  return NO_LOCALS;
}

/**
 * Text ending immediately before the schema root's `{`: a call's argument —
 * `v.object(` or `Xt(` — or, from 2.1.284, a returned plain object of thunks
 * (`return{`). This is the shape test that replaces matching a literal
 * `<alias>.object({`.
 */
const ROOT_BEFORE_BRACE = /(?:(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\(|(?<![\w$])return)$/;

/** How far back from the root's `return` to look for the block that holds it. */
const BLOCK_WINDOW = 65_536;
/** How many braces to try before giving up on finding that block. */
const BLOCK_TRIES = 256;

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
    if (!ROOT_BEFORE_BRACE.test(src.slice(Math.max(0, i - 64), i))) continue;
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
function describeOf(value: string, resolve: StringResolver): string | undefined {
  const m = /\.describe\((["'`])((?:\\.|(?!\1).)*)\1\)/.exec(value);
  const raw = m?.[2];
  if (raw !== undefined && !(m?.[1] === '`' && raw.includes('${'))) return detach(unescapeRaw(raw));
  // Not one plain literal: a joined description (`"…"+"…"`, `"…"+Gs`) or a
  // template that interpolates constants (`${po}, true from ${st}…`). Fold it
  // to the string it evaluates to. The raw `${…}` text would churn with every
  // build's minified names, so a description that does not fold to a string is
  // left out, as before.
  const at = m ? m.index : value.indexOf(DESCRIBE_CALL);
  if (at === -1) return undefined;
  const arg = callArgument(value, at + DESCRIBE_CALL.length);
  const text = arg && foldString(arg, resolve, 0);
  return text === undefined ? undefined : detach(text);
}

const DESCRIBE_CALL = '.describe(';

/** Resolves a name to the string constant it is bound to, or `undefined`. */
type StringResolver = (name: string, depth: number) => string | undefined;

/** How many names deep a string constant may be folded. */
const MAX_FOLD_DEPTH = 8;

/** A string literal's raw text, unescaped the way every description always has been. */
function unescapeRaw(raw: string): string {
  return raw.replace(/\\(["'`\\])/g, '$1');
}

/**
 * The argument of the call whose `(` ends just before `start`: the shortest
 * text up to a `)` that parses as one expression. A shorter candidate always
 * ends inside a string, a template or an inner call, and does not parse.
 */
function callArgument(text: string, start: number): Expression | undefined {
  for (
    let close = text.indexOf(')', start), tries = 0;
    close !== -1 && tries < 64;
    close = text.indexOf(')', close + 1), tries++
  ) {
    const expression = parseExpression(text.slice(start, close));
    if (expression) return expression;
  }
  return undefined;
}

/** `text` parsed as exactly one expression, or `undefined`. */
function parseExpression(text: string): Expression | undefined {
  const parsed = parseSync('expression.js', `(${text}\n)`, { sourceType: 'script' });
  const statement = parsed.program.body[0];
  if (parsed.errors.length > 0 || parsed.program.body.length !== 1) return undefined;
  const wrapped = (statement as ExpressionStatement).expression as ParenthesizedExpression;
  const inner = wrapped.expression;
  return inner.type === 'SequenceExpression' ? undefined : inner;
}

/** The string an expression of literals, `+` and constant names evaluates to. */
function foldString(node: Expression, resolve: StringResolver, depth: number): string | undefined {
  if (node.type === 'Literal')
    return typeof node.value === 'string'
      ? unescapeRaw((node.raw as string).slice(1, -1))
      : undefined;
  if (node.type === 'TemplateLiteral') {
    // A template always has one more text part than it has expressions.
    const quasis = node.quasis as { value: { raw: string } }[];
    let out = unescapeRaw((quasis[0] as { value: { raw: string } }).value.raw);
    for (const [i, expression] of node.expressions.entries()) {
      const part = foldString(expression as Expression, resolve, depth);
      if (part === undefined) return undefined;
      out += part + unescapeRaw((quasis[i + 1] as { value: { raw: string } }).value.raw);
    }
    return out;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = foldString(node.left as Expression, resolve, depth);
    const right = left === undefined ? undefined : foldString(node.right, resolve, depth);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === 'ParenthesizedExpression') return foldString(node.expression, resolve, depth);
  if (node.type === 'Identifier' && depth < MAX_FOLD_DEPTH) return resolve(node.name, depth + 1);
  return undefined;
}

/**
 * The string constant `name` is bound to in `src`, folded, or `undefined`.
 *
 * Minified names are reused across scopes, so this takes every `name=`
 * binding in the scope and answers only when all of those that fold to a
 * string give the same text. Two different texts mean the name is not known,
 * and the description is left out rather than taken from the wrong binding.
 */
function stringConstant(
  src: string,
  name: string,
  resolve: StringResolver,
  depth: number
): string | undefined {
  const binding = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*=(?![=>])\\s*`, 'g');
  const texts = new Set<string>();
  let seen = 0;
  for (const m of src.matchAll(binding)) {
    if (++seen > MAX_CONSTANT_BINDINGS) return undefined;
    const start = m.index + m[0].length;
    const value = constantValue(src, start);
    const text = value && foldString(value, resolve, depth);
    if (text !== undefined) texts.add(text);
    if (texts.size > 1) return undefined;
  }
  return texts.size === 1 ? [...texts][0] : undefined;
}

/** How many bindings of one name `stringConstant` weighs before giving up. */
const MAX_CONSTANT_BINDINGS = 256;

/**
 * The expression a binding's right side starts at `start`: the shortest text
 * up to a `,`, `;`, `)`, `}` or newline that parses as one expression.
 */
function constantValue(src: string, start: number): Expression | undefined {
  const window = src.slice(start, start + 8192);
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (c !== ',' && c !== ';' && c !== ')' && c !== '}' && c !== '\n') continue;
    const expression = parseExpression(window.slice(0, i));
    if (expression) return expression;
  }
  return undefined;
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
  /* v8 ignore next -- invariant guard: its only caller runs after walk's one-expression check, so the object always closes */
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
  valueEnd: number,
  resolve: StringResolver
): string | undefined {
  const bodyStart = objectBodyStart(value, valueStart);
  if (bodyStart === -1) return describeOf(value, resolve);
  const end = objectEnd(src, bodyStart);
  /* v8 ignore next -- the `end === -1` arm is an invariant guard: walk refuses a value that is not one expression, so an object it opens always closes */
  return end === -1 || end >= valueEnd ? undefined : describeOf(src.slice(end, valueEnd), resolve);
}

/** Where a union member's keys come from. */
type MemberTarget = { body: number } | { factory: string; refAt: number };

/**
 * Where each key-carrying union member's keys come from: an inline object call
 * (`u({…})`), a local bound to one, or a named factory (`zWl(e)`), looked
 * through any method chain and `lazy` wrapper. A name with no binding in scope,
 * or one reassigned after it was bound, throws: resolving it by text would reach
 * whatever same-named binding lies nearest, in any scope.
 */
function unionTargets(
  union: NonNullable<ReadValue['union']>,
  locals: Locals,
  path: string
): MemberTarget[] {
  const targets: MemberTarget[] = [];
  const refuse = (name: string, why: string): never => {
    throw new SettingsSchemaError(
      `settings schema: the union for "${path}" names ${name}, which has ${why}. ` +
        `Refusing to emit a key set that may be missing its keys.`
    );
  };
  const resolve = (node: Expression, shift: number, seen: readonly string[]): void => {
    let expr = node;
    for (let lazy = lazyGetter(expr); lazy; lazy = lazyGetter(expr)) {
      const getter = lazy.getter as ArrowFunctionExpression;
      /* v8 ignore next 2 -- a block-bodied getter in a union member has not been seen; it is refused rather than half-read */
      if (!getter.expression) refuse('a lazy member', 'a block-bodied getter');
      expr = getter.body as Expression;
    }
    const inline = objectArgument(expr);
    if (inline) {
      targets.push({ body: inline.start + shift + 1 });
      return;
    }
    const base = chainBase(expr);
    if (base.type === 'Identifier') {
      const binding = locals.get(base.name);
      if (binding === undefined) return refuse(base.name, 'no binding in scope');
      if (binding === 'reassigned') return refuse(base.name, 'been reassigned');
      if (binding === 'destructured') return refuse(base.name, 'a destructured binding');
      if (binding === 'unknown') return;
      if (seen.includes(base.name)) return refuse(base.name, 'a binding cycle');
      resolve(binding.node, binding.shift, [...seen, base.name]);
    } else if (base.type === 'CallExpression' && base.callee.type === 'Identifier') {
      targets.push({ factory: base.callee.name, refAt: base.start + shift });
    }
  };
  for (const member of union.members) {
    if (member && member.type !== 'SpreadElement') resolve(member, union.shift, []);
  }
  return targets;
}

/**
 * One module scope the walk resolves names in: a `// @bun @bytecode` chunk of the
 * code-split era, or the whole bundle before it.
 *
 * From 2.1.242 the compiled release is ~1400 ES-module chunks that import each
 * other from under `/$bunfs/root/`, and each chunk minifies its OWN top-level
 * names. `Ne` is the zod union builder in the settings chunk and an unrelated
 * lazy object in another, so a name means nothing outside the chunk that binds
 * it. Resolving a factory across the flat concatenation is what invented
 * `theme.jws` at 2.1.261, `viewMode.tier` at 2.1.248 and `hooks.session_id` at
 * 2.1.242 — and lost `permissions.allow` for fifteen releases while it sat
 * plainly in the source.
 */
interface Scope {
  src: string;
  /** Position in the chunk list — the cache key, since chunks carry no name. */
  index: number;
  /** Local name → the module and export it came from (`import{E as L}from"m"` ⇒ L → m, E). */
  imports: Map<string, { source: string; name: string }>;
  /** Exported name → local binding (`export{L as E}` ⇒ E → L). */
  exports: Map<string, string>;
}

/** The chunk list with, per source string, every name any chunk imports from it. */
interface ModuleGraph {
  scopes: Scope[];
  namesBySource: Map<string, Set<string>>;
  /** Source string → the one chunk that is that module, or null when unidentifiable. */
  sourceCache: Map<string, Scope | null>;
  /** `<scope index>\0<name>` → the name's candidate definitions in that scope. */
  defCache: Map<string, RegExpExecArray[]>;
}

/**
 * A chunk's cross-chunk import and export statements. Anchored at a statement
 * boundary so the same text inside a string literal cannot register a binding. A
 * re-export facade (`export{X as Y}from"m"`) is not an export of this chunk and is
 * deliberately not matched — see `moduleOf`.
 */
const IMPORT_STATEMENT = /(?:^|[;\n])import\{([^}]*)\}from"([^"]+)"/g;
const EXPORT_STATEMENT = /(?:^|[;\n])export\{([^}]*)\}(?!from")/g;

/** `a as b` → [a, b]; `a` → [a, a]. */
function aliasPair(spec: string): [string, string] | undefined {
  const [left, right] = spec.trim().split(/\s+as\s+/);
  if (!left) return undefined;
  return [left, right ?? left];
}

function moduleGraph(chunks: readonly string[]): ModuleGraph {
  const scopes = chunks.map((src, index): Scope => {
    const imports = new Map<string, { source: string; name: string }>();
    const exports = new Map<string, string>();
    for (const m of src.matchAll(IMPORT_STATEMENT)) {
      for (const spec of (m[1] as string).split(',')) {
        const pair = aliasPair(spec);
        if (pair) imports.set(pair[1], { source: m[2] as string, name: pair[0] });
      }
    }
    for (const m of src.matchAll(EXPORT_STATEMENT)) {
      for (const spec of (m[1] as string).split(',')) {
        const pair = aliasPair(spec);
        if (pair) exports.set(pair[1], pair[0]);
      }
    }
    return { src, index, imports, exports };
  });
  const namesBySource = new Map<string, Set<string>>();
  for (const scope of scopes) {
    for (const { source, name } of scope.imports.values()) {
      const names = namesBySource.get(source);
      if (names) names.add(name);
      else namesBySource.set(source, new Set([name]));
    }
  }
  return { scopes, namesBySource, sourceCache: new Map(), defCache: new Map() };
}

/**
 * The chunk that IS the module a source string names, or null.
 *
 * Chunks carry no filename of their own, so the source cannot be matched by name.
 * It is matched structurally, the same way the control lane links its chunks: the
 * module a name is imported FROM must export that name, so the chunk exporting
 * every name imported from a given source is that source. Zero or several
 * matches is an unidentifiable module, and the caller refuses rather than guesses.
 */
function moduleOf(source: string, graph: ModuleGraph): Scope | null {
  const cached = graph.sourceCache.get(source);
  if (cached !== undefined) return cached;
  const wanted = [...(graph.namesBySource.get(source) as Set<string>)];
  let match: Scope | null = null;
  let count = 0;
  for (const scope of graph.scopes) {
    if (!wanted.every((n) => scope.exports.has(n))) continue;
    match = scope;
    if (++count > 1) break;
  }
  const resolved = count === 1 ? match : null;
  graph.sourceCache.set(source, resolved);
  return resolved;
}

/**
 * Where a sub-schema factory's object body begins, and in which scope. `body` is
 * -1 when the factory resolves to something that is not an object literal.
 *
 * A name bound by an import is followed to the module it names and resolved
 * THERE, under the local name that module exports it as — never searched for in
 * the referencing chunk, where the same spelling may bind something unrelated.
 * A module that only re-exports the name hops once more. Everything else is a
 * local binding and resolves within its own chunk, exactly as the pre-split
 * bundle did within its single scope.
 */
function resolveFactory(
  scope: Scope,
  name: string,
  path: string,
  refAt: number,
  graph: ModuleGraph,
  hops = 0
): { scope: Scope; body: number } {
  const binding = scope.imports.get(name);
  if (!binding) return { scope, body: factoryBodyStart(scope, name, path, refAt, graph.defCache) };
  if (hops >= MAX_DEPTH) {
    throw new SettingsSchemaError(
      `settings schema: sub-schema factory ${name}() for "${path}" re-exports in a cycle. ` +
        `Refusing to emit a partial key set.`
    );
  }
  const target = moduleOf(binding.source, graph);
  if (target === null) {
    throw new SettingsSchemaError(
      `settings schema: sub-schema factory ${name}() for "${path}" is imported from a module ` +
        `the chunk graph cannot identify uniquely. Refusing to emit a partial key set ` +
        `(it would read as removals downstream).`
    );
  }
  // `moduleOf` accepted `target` only because it exports every name imported from
  // this source, and `binding.name` is one of them.
  const local = target.exports.get(binding.name) as string;
  return resolveFactory(target, local, path, 0, graph, hops + 1);
}

/**
 * Where a sub-schema factory's object body begins within ONE scope, or -1 when
 * the factory resolves to something that is not an object literal.
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
  scope: Scope,
  name: string,
  path: string,
  refAt: number,
  cache: Map<string, RegExpExecArray[]>
): number {
  const { src } = scope;
  const id = escapeRegExp(name);
  const patterns = [
    // memoized lazy binding — `NAME=Se(()=>Xt({…}))`
    `(?<![\\w$])${id}\\s*=\\s*[A-Za-z_$][\\w$]*\\(\\([^)]{0,40}\\)\\s*=>\\s*`,
    // plain declaration — `function NAME(e){return Xt({…})}`
    `function ${id}\\([^)]{0,40}\\)\\{return\\s*`,
    // direct binding — `NAME=Rt(qt(),Xt({…}))`, how the early eras emit `env`
    `(?<![\\w$])${id}\\s*=\\s*`,
    // any other declaration — `function NAME(e,t){let r=…`, a zod builder such
    // as `enum` whose body does not open with `return`. It is a definition, so
    // the name is not unresolvable; it is just not an object literal. Last tier,
    // because it can only say "no children", never find any.
    `function ${id}\\(`,
  ];
  // Minified names are reused across module scopes, so "first match in 20 MB" can
  // resolve to an unrelated binding — that is how `sandbox.filesystem` went missing
  // for 91 releases while the key was plainly in the source. Bundlers emit a
  // binding near its use, so prefer the definition CLOSEST to the reference,
  // looking behind first (declaration order) and only then ahead (hoisted/lazy).
  // Memoized per bundle: without this, every key rescans the whole 20 MB source
  // for its callee, and the tree-shaken era routes every leaf's builder through
  // here — O(keys x bundle) for no gain, since a name's definitions never move.
  const cacheKey = `${scope.index}\0${name}`;
  let all = cache.get(cacheKey);
  if (all === undefined) {
    all = [];
    for (const pattern of patterns) {
      all = [...src.matchAll(new RegExp(pattern, 'g'))] as RegExpExecArray[];
      if (all.length > 0) break;
    }
    cache.set(cacheKey, all);
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

/**
 * Every configurable key in the bundle's settings schema.
 *
 * `source` is the bundle, or from 2.1.242 the list of its `// @bun @bytecode`
 * chunks in bundle order. A chunk list is walked by module: the schema root is
 * found in the first chunk that declares an anchor key, and every sub-schema
 * reference resolves inside the chunk that binds it. Passing the flat
 * concatenation instead would resolve minified names across ~1400 unrelated
 * scopes — see `Scope`. A single string is one scope with no imports, which is
 * the pre-split bundle and the npm tarball exactly as before.
 *
 * Returns `[]` when the bundle has no settings schema at all (before 0.2.123).
 * Throws `SettingsSchemaError` when a schema IS present but cannot be walked in
 * full — an unrecognised emission shape, an unreachable root, an unresolvable
 * sub-schema factory, or a root that yields nothing. Callers must let that
 * propagate and fail the version.
 */
export function extractSettingsKeys(source: string | readonly string[]): SettingsKey[] {
  const graph = moduleGraph(typeof source === 'string' ? [source] : source);
  let anchorScope: Scope | undefined;
  let anchorMatch: RegExpExecArray | null = null;
  for (const scope of graph.scopes) {
    anchorMatch = ANCHOR_RE.exec(scope.src);
    if (anchorMatch) {
      anchorScope = scope;
      break;
    }
  }
  if (!anchorMatch || !anchorScope) return []; // no settings schema in this era — legitimately empty

  // String.prototype.split never returns an empty array.
  const anchorKey = anchorMatch[0].split(':')[0]!;
  const anchorValueAt = anchorMatch.index + anchorKey.length + 1;
  const root = schemaRootStart(anchorScope.src, anchorMatch.index, anchorKey, anchorValueAt);
  if (root === -1) {
    throw new SettingsSchemaError(
      'settings schema: found an anchor key but could not reach the enclosing schema root. ' +
        'The emission shape likely changed; refusing to emit a partial key set.'
    );
  }

  const keys: SettingsKey[] = [];
  const alias = anchorMatch[1];
  // String constants a description names, resolved in the chunk that binds
  // them, following an import to the module it names. Memoized per chunk and
  // name; the placeholder `null` also stops a cycle.
  const stringCache = new Map<string, string | null>();
  const resolvers = new Map<Scope, StringResolver>();
  const strings = (scope: Scope): StringResolver => {
    const known = resolvers.get(scope);
    if (known) return known;
    const resolve: StringResolver = (name, depth) => {
      const key = `${scope.index}\0${name}`;
      const cached = stringCache.get(key);
      if (cached !== undefined) return cached ?? undefined;
      stringCache.set(key, null);
      const binding = scope.imports.get(name);
      let text: string | undefined;
      if (binding) {
        const target = moduleOf(binding.source, graph);
        const local = target?.exports.get(binding.name);
        text = target && local ? strings(target)(local, depth) : undefined;
      } else {
        text = stringConstant(scope.src, name, resolve, depth);
      }
      stringCache.set(key, text ?? null);
      return text;
    };
    resolvers.set(scope, resolve);
    return resolve;
  };
  const walk = (
    scope: Scope,
    start: number,
    prefix: string,
    depth: number,
    locals: Locals,
    viaFactory?: string
  ): void => {
    const { src } = scope;
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
    for (const entry of scanLevel(src, start)) {
      const path = prefix ? `${prefix}.${entry.key}` : entry.key;
      const read = readValue(src, entry.valueStart, entry.valueEnd, path, locals);
      const { valueStart, valueEnd, childStart, childEnd, tail, union } = read;
      keys.push({
        path: detach(path),
        // A `lazy` call or a union carries its own description after it closes,
        // the same rule `describeKey` applies to an object.
        description:
          tail !== undefined
            ? describeOf(src.slice(tail, valueEnd), strings(scope))
            : union
              ? describeOf(src.slice(union.end, valueEnd), strings(scope))
              : describeKey(
                  src,
                  src.slice(valueStart, valueEnd),
                  valueStart,
                  valueEnd,
                  strings(scope)
                ),
        viaFactory,
      });
      const value = src.slice(childStart, childEnd);

      const inlineBody = objectBodyStart(value, childStart);
      if (inlineBody !== -1) {
        walk(scope, inlineBody, path, depth + 1, read.locals, viaFactory);
        continue;
      }
      // A union passed its members inline as an array — `Fe([H(),i],{…})`, how
      // `attribution` is emitted from 2.1.281, where `i` is a local
      // `i=u({commit:…})`. The union's keys are its object members' keys.
      // Resolving the callee instead reaches the union builder, which is not an
      // object, and that dropped `attribution.commit`, `.pr` and `.sessionUrl`.
      // The callee is never resolved for a union, for the same name-collision
      // reason as the record guard below.
      if (union) {
        const bodies: { scope: Scope; body: number; via?: string }[] = [];
        for (const target of unionTargets(union, read.locals, path)) {
          if ('body' in target) {
            bodies.push({ scope, body: target.body, via: viaFactory });
            continue;
          }
          const factory = resolveFactory(scope, target.factory, path, target.refAt, graph);
          if (factory.body !== -1)
            bodies.push({ scope: factory.scope, body: factory.body, via: target.factory });
        }
        // Two object members would make the keys depend on which branch matched,
        // a shape this walk does not model.
        if (bodies.length > 1) {
          throw new SettingsSchemaError(
            `settings schema: the union for "${path}" has more than one object member. ` +
              `Refusing to emit a key set that may be missing its keys.`
          );
        }
        for (const { scope: at, body, via } of bodies)
          walk(
            at,
            body,
            path,
            depth + 1,
            at === scope && via === viaFactory ? read.locals : NO_LOCALS,
            via
          );
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
      const factory = resolveFactory(scope, name, path, childStart, graph);
      // A factory is another function, so none of these locals reach into it.
      if (factory.body !== -1) walk(factory.scope, factory.body, path, depth + 1, NO_LOCALS, name);
    }
  };
  walk(anchorScope, root, '', 0, rootLocals(anchorScope.src, root));

  // Feature-gated fragments contribute top-level keys the root walk cannot reach:
  // they live in a separate registry (`{autoMode:{buildGate:()=>!0,shape:()=>({…})}}`)
  // that the schema merges in at build time, so nothing in the root object points
  // at them. At 2.1.226 that hid `autoMode`, `useAutoModeDuringPlan`,
  // `disableDeepLinkRegistration`, `voiceEnabled`, `axScreenReader` and
  // `defaultView` — five of which settings.md documents, which is how the gap
  // surfaced.
  // Every chunk is scanned: a fragment lives wherever its feature's module does,
  // and each is walked in its own scope.
  const rootCount = keys.length;
  for (const scope of graph.scopes) {
    for (const { bodyStart } of gatedFragments(scope.src))
      walk(scope, bodyStart, '', 1, NO_LOCALS, 'gated-fragment');
  }

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
