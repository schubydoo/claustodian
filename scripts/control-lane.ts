// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — the stream-json control protocol.
 *
 * When Claude Code runs with `--input-format stream-json --output-format
 * stream-json` it exchanges JSON messages with a host application over
 * stdin/stdout. Claustodian already catalogues the TRANSPORT for that channel
 * (`--input-format`, `--replay-user-messages`, `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`
 * and friends). This module catalogues the VOCABULARY that travels inside it:
 * the `control_request` subtypes a host must implement to drive the CLI.
 *
 * WHY A PARSER, WHEN EVERY OTHER LANE USES REGEX. The subtype names themselves
 * are findable with a regex — measured at 116/116 recall against the parser on
 * 2.1.226. Two things are not. `direction` comes from which of two disjoint
 * sub-unions a subtype belongs to, and union membership is a set of variable
 * references inside an array; and a description must be scoped to its own
 * object, because pairing a subtype with the next `.describe()` in the text
 * attributes a nested field's prose to the message (observed: `initialize`
 * receiving plan-mode text, `set_color` receiving MCP connection-status text).
 * Neither is expressible as a character window. That is the whole justification
 * for the `oxc-parser` dependency; it buys structure, not name recall.
 *
 * FIVE SHAPES, NONE OF THEM OPTIONAL. A subtype reaches the bundle as:
 *   1. a schema literal        `Se({subtype:xt("hook_callback"), ...})`
 *   2. a bare object literal   `this.request({subtype:"remote_control", ...})`
 *   3. a dispatch comparison   `e.request.subtype === "add_directory"`
 *   4. an enum of literals     `subtype:$r(["error_max_turns", ...])`
 *   5. a dynamic forward       `{subtype: m.subtype}`
 * Shape 2 is the one that bites: `remote_control` has no schema in any build
 * examined, so a schema-only scrape drops it along with ~19 others. Shape 5 is
 * a re-emission of a received subtype, not a declaration, and is correctly
 * invisible here — it is not a coverage gap.
 *
 * WHAT THIS DOES NOT DECIDE. Finding a `subtype` literal is not finding a
 * control request. The same key is used by system messages, control responses,
 * result messages, hook lifecycle events and — the trap — analytics payloads:
 * `O("tengu_sdk_result", {subtype: Ce("terminated"), ...})` is shaped exactly
 * like a real subtype and never touches the wire.
 *
 * So membership is decided POSITIVELY, never by excluding known contaminants: a
 * subtype is a control request when it belongs to a union the CLI routes as
 * control requests, or when the CLI dispatches it on `<expr>.request.subtype`.
 * That handler path is what separates the families, cleanly — measured on
 * 2.1.226, the three control-request unions score 7/7, 34/35 and 41/42 members
 * on it while the system-message, control-response and summary unions score 0.
 * A denylist was tried first and is the wrong shape: it admits anything a future
 * release invents, whereas this admits only what the CLI demonstrably routes.
 *
 * FLOORS. The protocol is far older than its own self-description. The names
 * date from 1.0.45; the first zod schema appears at 2.1.20, the first union at
 * 2.1.30, the first description at 2.1.63, and the direction split at 2.1.133.
 * So `first_seen` must never be taken from the schema lane — dating from
 * schemas would move the whole surface ~120 releases later and manufacture a
 * mass introduction. Below CONTROL_UNION_FLOOR this module yields nothing and
 * absence is expected; at or above it, an empty result is a bug and throws.
 */
import { parseSync } from 'oxc-parser';
import { compareVersionsAsc } from './lib.js';

/** First version with a union array of control-request schemas (2.1.29 has none). */
export const CONTROL_UNION_FLOOR = '2.1.30';

/**
 * First version whose control-request union splits into two disjoint sub-unions,
 * one per direction. Below this the split does not exist and `direction` is
 * genuinely unobservable — it is reported as null, never borrowed from a later
 * release.
 */
export const CONTROL_SPLIT_FLOOR = '2.1.133';

/**
 * Prose anchors from the sub-unions' own `.describe()` text. The bundle states
 * each side in English — "Control requests the agent loop originates …" versus
 * "Control requests a client sends to drive the loop …" — which is positive
 * evidence and the only reliable signal available.
 *
 * Call sites cannot substitute: the bundle ships BOTH sides of the protocol (the
 * SDK lets a JS program act as the host), so every subtype has an outbound
 * construction and an inbound handler somewhere in the same file. Measured on
 * 2.1.226: both sub-unions score 7/7 on each signal.
 */
const LOOP_ORIGINATES = 'the agent loop originates';
const CLIENT_SENDS = 'a client sends to drive the loop';

/** Which side of the channel sends a message; null when unobservable. */
export type ControlDirection = 'host_to_cli' | 'cli_to_host' | null;

/** How strongly the bundle evidences a subtype. */
export type ControlEvidence = 'schema' | 'call_site' | 'dispatch';

/** One control-request subtype as observed in a single bundle. */
export interface ControlMessageObservation {
  symbol: string;
  family: 'control_request';
  direction: ControlDirection;
  /** The schema object's own `.describe()` text; empty when it has none. */
  description: string;
  evidence: ControlEvidence;
}

/* -------------------------------------------------------------------------- */
/* AST helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Minimal ESTree node. The parser's own types are structural; this is enough. */
interface Node {
  type: string;
  [key: string]: unknown;
}

const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

const isStringLiteral = (n: unknown): n is Node & { value: string } =>
  isNode(n) && n.type === 'Literal' && typeof (n as { value?: unknown }).value === 'string';

/** A property's key, whether written bare or quoted. */
function propertyName(p: unknown): string | undefined {
  if (!isNode(p) || p.type !== 'Property') return undefined;
  const key = p.key;
  if (isNode(key) && key.type === 'Identifier') return key.name as string;
  if (isStringLiteral(key)) return key.value;
  return undefined;
}

function findProperty(obj: unknown, name: string): Node | undefined {
  if (!isNode(obj) || obj.type !== 'ObjectExpression') return undefined;
  const props = obj.properties as unknown[];
  return props.find((p) => propertyName(p) === name) as Node | undefined;
}

/**
 * `BUILDER("literal")` under any builder name, which is how a zod literal
 * survives minification. Anchoring on the shape rather than the identifier is
 * what keeps this working across releases: the same schema reads
 * `w.literal("hook_callback")` in one build and `xt("hook_callback")` in the
 * next, six releases apart.
 */
function singleStringArgument(n: unknown): string | undefined {
  if (!isNode(n) || n.type !== 'CallExpression') return undefined;
  const args = n.arguments as unknown[];
  if (args.length !== 1) return undefined;
  return isStringLiteral(args[0]) ? args[0].value : undefined;
}

/** Walks every node, recording each one's parent. */
function indexParents(root: Node): Map<Node, Node | null> {
  const parents = new Map<Node, Node | null>();
  const visit = (node: unknown, parent: Node | null): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (!isNode(node)) return;
    parents.set(node, parent);
    for (const key of Object.keys(node)) {
      if (key === 'type') continue;
      const value = node[key];
      if (value && typeof value === 'object') visit(value, node);
    }
  };
  visit(root, null);
  return parents;
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

interface Candidate {
  symbol: string;
  node: Node;
  evidence: ControlEvidence;
  description: string;
  /**
   * True when this candidate is a dispatch comparison against
   * `<expr>.request.subtype` — the CLI's control-request handler path, and the
   * signal that decides family membership. A comparison against a plain
   * `<expr>.subtype` is some other family's handler and proves nothing here.
   */
  onRequestPath?: boolean;
}

/**
 * Parses as a script, then as a module. npm-era `cli.js` is ESM while the
 * Bun-embedded bundle is CJS-wrapped; hardcoding either yields parse errors on
 * every version of the other format.
 */
function parse(source: string): Node {
  let best: { errors: unknown[]; program: Node } | undefined;
  for (const sourceType of ['script', 'module'] as const) {
    const attempt = parseSync('bundle.js', source, { sourceType }) as unknown as {
      errors: unknown[];
      program: Node;
    };
    if (attempt.errors.length === 0) return attempt.program;
    if (!best || attempt.errors.length < best.errors.length) best = attempt;
  }
  throw new Error(
    `control lane: failed to parse the bundle (${best?.errors.length ?? 0} error(s)). ` +
      'Refusing to continue — an unparsed bundle would report zero symbols, which ' +
      'is indistinguishable from a protocol that vanished.'
  );
}

/** Text of a node, for callee inspection. */
const textOf = (source: string, n: Node): string =>
  source.slice(n.start as number, n.end as number);

/**
 * Every object literal carrying a `subtype`, plus every dispatch comparison
 * against one. Enum-shaped subtypes (shape 4) are deliberately collected too, so
 * the family filter can drop them explicitly rather than by silent omission.
 */
function collectCandidates(
  source: string,
  parents: Map<Node, Node | null>
): { candidates: Candidate[]; schemaVariable: Map<string, string> } {
  const candidates: Candidate[] = [];
  const schemaVariable = new Map<string, string>();

  for (const node of parents.keys()) {
    if (node.type === 'ObjectExpression') {
      const property = findProperty(node, 'subtype');
      if (property) collectFromObject(node, property, parents, candidates, schemaVariable);
      continue;
    }
    if (node.type === 'BinaryExpression' && (node.operator === '===' || node.operator === '==')) {
      const dispatched = dispatchedName(source, node);
      if (dispatched) {
        candidates.push({
          symbol: dispatched.symbol,
          node,
          evidence: 'dispatch',
          description: '',
          onRequestPath: dispatched.onRequestPath,
        });
      }
    }
  }
  return { candidates, schemaVariable };
}

function collectFromObject(
  object: Node,
  property: Node,
  parents: Map<Node, Node | null>,
  candidates: Candidate[],
  schemaVariable: Map<string, string>
): void {
  const value = property.value;
  const literal = isStringLiteral(value) ? value.value : undefined;
  const built = singleStringArgument(value);
  const symbol = literal ?? built;
  // Shape 4 (enum) and shape 5 (dynamic forward) both land here with no single
  // name. Neither declares a control request: the enum belongs to the result
  // message family, and a forward re-emits a subtype it was handed.
  if (!symbol) return;

  candidates.push({
    symbol,
    node: object,
    evidence: built ? 'schema' : 'call_site',
    description: built ? ownDescription(object, parents) : '',
  });

  if (built) {
    const bound = boundVariable(object, parents);
    if (bound) schemaVariable.set(bound, symbol);
  }
}

/**
 * `<expr>.subtype === "name"` in either operand order, with the member path so
 * the caller can tell a control-request handler from any other family's.
 */
function dispatchedName(
  source: string,
  node: Node
): { symbol: string; onRequestPath: boolean } | undefined {
  const left = node.left;
  const right = node.right;
  const onLeft =
    isNode(left) && left.type === 'MemberExpression' && (left.property as Node)?.name === 'subtype';
  const onRight =
    isNode(right) &&
    right.type === 'MemberExpression' &&
    (right.property as Node)?.name === 'subtype';
  const member = onLeft ? (left as Node) : onRight ? (right as Node) : undefined;
  const literal = onLeft ? right : onRight ? left : undefined;
  if (!member || !isStringLiteral(literal)) return undefined;
  return {
    symbol: literal.value,
    onRequestPath: /\brequest\.subtype$/.test(textOf(source, member)),
  };
}

/**
 * The `.describe()` attached to this object's OWN schema wrapper — `Se({…})`,
 * then `.describe`, then its call. Anything further out belongs to an enclosing
 * construct, which is exactly how a nested field's prose gets misattributed to
 * the message.
 */
function ownDescription(object: Node, parents: Map<Node, Node | null>): string {
  const wrapper = parents.get(object);
  if (!wrapper || wrapper.type !== 'CallExpression') return '';
  const member = parents.get(wrapper);
  if (!member || member.type !== 'MemberExpression') return '';
  if ((member.property as Node)?.name !== 'describe') return '';
  const call = parents.get(member);
  if (!call || call.type !== 'CallExpression') return '';
  const first = (call.arguments as unknown[])[0];
  return isStringLiteral(first) ? first.value : '';
}

/**
 * The variable a schema is bound to. Both forms are needed: bun lazy-inits
 * assign (`X = Ee(() => …)`) rather than declare, and indexing only declarator
 * inits misses them.
 */
function boundVariable(object: Node, parents: Map<Node, Node | null>): string | undefined {
  let current: Node | null = object;
  for (let hops = 0; current && hops < 10; hops += 1) {
    current = parents.get(current) ?? null;
    if (!current) return undefined;
    if (current.type === 'VariableDeclarator') {
      const id = current.id;
      if (isNode(id) && id.type === 'Identifier') return id.name as string;
    }
    if (current.type === 'AssignmentExpression') {
      const target = current.left;
      if (isNode(target) && target.type === 'Identifier') return target.name as string;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Unions and direction                                                       */
/* -------------------------------------------------------------------------- */

interface Union {
  members: Set<string>;
  description: string;
  /** True when the CLI routes this union's members as control requests. */
  isControlRequest: boolean;
}

/** An array element referencing a schema, bare or as a zero-argument thunk call. */
function referencedName(element: unknown): string | undefined {
  if (!isNode(element)) return undefined;
  if (element.type === 'Identifier') return element.name as string;
  if (
    element.type === 'CallExpression' &&
    isNode(element.callee) &&
    (element.callee as Node).type === 'Identifier' &&
    (element.arguments as unknown[]).length === 0
  ) {
    return (element.callee as Node).name as string;
  }
  return undefined;
}

/** Arrays whose elements resolve to two or more known schemas. */
function collectUnions(
  parents: Map<Node, Node | null>,
  schemaVariable: Map<string, string>,
  requestDispatched: ReadonlySet<string>
): Union[] {
  const unions: Union[] = [];
  for (const node of parents.keys()) {
    if (node.type !== 'ArrayExpression') continue;
    const elements = node.elements as unknown[];
    if (elements.length === 0) continue;
    const members = new Set<string>();
    for (const element of elements) {
      const reference = referencedName(element);
      const symbol = reference ? schemaVariable.get(reference) : undefined;
      if (symbol) members.add(symbol);
    }
    if (members.size < 2) continue;
    // Majority, not "any": a stray shared name should not recruit a whole union
    // into the wrong family.
    const routed = [...members].filter((m) => requestDispatched.has(m)).length;
    unions.push({
      members,
      description: unionDescription(node, parents),
      isControlRequest: routed * 2 > members.size,
    });
  }
  return unions;
}

/** The `.describe()` on the call that consumes a union array. */
function unionDescription(array: Node, parents: Map<Node, Node | null>): string {
  const call = parents.get(array);
  if (!call || call.type !== 'CallExpression') return '';
  const member = parents.get(call);
  if (!member || member.type !== 'MemberExpression') return '';
  if ((member.property as Node)?.name !== 'describe') return '';
  const describeCall = parents.get(member);
  if (!describeCall || describeCall.type !== 'CallExpression') return '';
  const first = (describeCall.arguments as unknown[])[0];
  return isStringLiteral(first) ? first.value : '';
}

/**
 * Maps each subtype to a direction using the sub-unions' own prose. Returns an
 * empty map when the split is not present, which is the correct answer below
 * CONTROL_SPLIT_FLOOR rather than a failure.
 */
function directionsFrom(unions: Union[]): Map<string, ControlDirection> {
  const directions = new Map<string, ControlDirection>();
  for (const union of unions) {
    let side: ControlDirection = null;
    if (union.description.includes(LOOP_ORIGINATES)) side = 'cli_to_host';
    else if (union.description.includes(CLIENT_SENDS)) side = 'host_to_cli';
    if (!side) continue;
    for (const member of union.members) directions.set(member, side);
  }
  return directions;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Confidence for a record, from the strength of the evidence behind it.
 * A schema that describes itself is the strongest thing the bundle offers;
 * a dispatch comparison proves only that the CLI handles the message.
 */
export function controlMessageConfidence(
  observation: ControlMessageObservation
): 'high' | 'medium' | 'low' {
  if (observation.evidence === 'dispatch') return 'low';
  if (observation.evidence === 'schema' && observation.description !== '') return 'high';
  return 'medium';
}

/**
 * Extracts the `control_request` subtypes from one bundle's source.
 *
 * Throws rather than returning an empty array at or above CONTROL_UNION_FLOOR:
 * downstream, zero symbols reads as every symbol having been removed at once.
 */
export function extractControlMessages(
  source: string,
  version: string
): ControlMessageObservation[] {
  const program = parse(source);
  const parents = indexParents(program);
  const { candidates, schemaVariable } = collectCandidates(source, parents);

  // The handler path first: union ownership is derived from it, so it has to
  // exist before the unions are classified.
  const requestDispatched = new Set(candidates.filter((c) => c.onRequestPath).map((c) => c.symbol));
  const unions = collectUnions(parents, schemaVariable, requestDispatched);
  const controlMembers = new Set(
    unions.filter((u) => u.isControlRequest).flatMap((u) => [...u.members])
  );
  const directions = directionsFrom(unions);

  // Positive admission. Everything else carrying a `subtype` key — system
  // messages, control responses, result-message enums, telemetry payloads — is
  // absent because nothing proves it belongs, not because it was filtered out.
  const belongs = (symbol: string): boolean =>
    controlMembers.has(symbol) || requestDispatched.has(symbol);

  const observations = new Map<string, ControlMessageObservation>();
  const rank: Record<ControlEvidence, number> = { dispatch: 0, call_site: 1, schema: 2 };

  for (const candidate of candidates) {
    if (!belongs(candidate.symbol)) continue;
    const existing = observations.get(candidate.symbol);
    observations.set(candidate.symbol, {
      symbol: candidate.symbol,
      family: 'control_request',
      direction: directions.get(candidate.symbol) ?? null,
      description: candidate.description || existing?.description || '',
      evidence:
        existing && rank[existing.evidence] >= rank[candidate.evidence]
          ? existing.evidence
          : candidate.evidence,
    });
  }

  const result = [...observations.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (result.length === 0 && compareVersionsAsc(version, CONTROL_UNION_FLOOR) >= 0) {
    throw new Error(
      `control lane: no control_request subtypes found at ${version}, at or above the ` +
        `${CONTROL_UNION_FLOOR} union floor. Refusing to report zero — downstream that ` +
        'reads as every subtype being removed in one release.'
    );
  }
  return result;
}
