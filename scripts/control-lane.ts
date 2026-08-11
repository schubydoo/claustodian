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
 * COST, AND THE LIMIT IT IMPLIES. Measured on this hardware: 2.1.226 (22.9 MiB of
 * embedded JS) takes 3.7 s and peaks at ~2.6 GB RSS; 2.1.112 (13.0 MiB, npm) takes
 * 2.3 s and ~1.4 GB. Nearly all of it is `indexParents`, which materialises one Map
 * entry per AST node so the upward walks can run.
 *
 * That is affordable per version and NOT affordable naively across the archive:
 * 3.7 s x 472 releases is ~29 minutes, which is worse than the 2.2 s/version
 * (~17 minutes) that `env-registry.ts` documents REJECTING for the same reason.
 * Nothing calls this module yet, so the trade is not live — but whoever wires it
 * into a full sweep owns that number. Cheapest fixes, in order: restrict the sweep
 * to versions at or above the union floor, collect candidates and unions in one
 * traversal instead of two, and replace the parent Map with a walk that carries its
 * own parent chain. Do not add it to `reextract-binaries` without one of them.
 *
 * FLOORS. The protocol is far older than its own self-description. The names
 * date from 1.0.45; the first zod schema appears at 2.1.20, the first union at
 * 2.1.30 (though the first union the CLI ROUTES as control requests is 2.1.63 —
 * see CONTROL_UNION_FLOOR, the two are not the same thing), the first description
 * at 2.1.63, and the direction split at 2.1.133.
 * So `first_seen` must never be taken from the schema lane — dating from
 * schemas would move the whole surface ~120 releases later and manufacture a
 * mass introduction.
 *
 * Below CONTROL_UNION_FLOOR this module does NOT yield nothing — an earlier
 * version of this comment claimed it did, and the code has never behaved that way.
 * `belongs` reduces to the dispatch signal there, which still works: 1 symbol at
 * 1.0.45, 3 at 1.0.93, 7 at 2.0.30. That era is precisely the one that can date
 * the surface correctly, so it is guarded too — see CONTROL_DISPATCH_FLOOR. Only
 * below 1.0.45 is an empty result expected.
 */
import { parseSync } from 'oxc-parser';
import { compareVersionsAsc } from './lib.js';

/**
 * First version carrying a union the CLI ROUTES as control requests.
 *
 * ⚠️ Not the same thing as the first union of subtype schemas, which is 2.1.30 —
 * this constant was originally set to that number, and it was wrong. A union of
 * schemas exists from 2.1.30, but through 2.1.62 its members are largely not
 * dispatched on the control-request handler path, so `isControlRequest` is false
 * and there is no routed union to demand. Measured with this module: 2.1.62 yields
 * 16 symbols and no routed union, 2.1.63 yields 20 and has one. (With the floor at
 * 2.1.63 the union guard does not fire at 2.1.62 — it is below the floor. An
 * earlier version of this comment said it did, which was true only of the 2.1.30
 * floor it replaced.)
 *
 * ⚠️ THIS FLOOR IS A DATING BOUNDARY, and the 16 -> 20 step across it is not four
 * new subtypes. Attributed against the two bundles rather than inferred:
 *   elicitation            — string present at 2.1.62, not declared as a subtype
 *   mcp_oauth_callback_url — absent from 2.1.62 entirely
 *   remote_control         — absent from 2.1.62 entirely
 *   hook_callback          — ALREADY DECLARED at 2.1.62, and undetectable there
 * so three of the four are genuine arrivals and one is a false introduction.
 *
 * What makes `hook_callback` undetectable at 2.1.62 is measured, not reasoned:
 * there it is neither request- nor plain-dispatched, so its only evidence is
 * membership of a union nothing yet proves is a control-request union. Do NOT read
 * a mechanism into that beyond the measurement — in particular it is not "CLI->host
 * subtypes have no handler", which this file measures the opposite of twice (the
 * cli_to_host sub-union scores 7/7 on the request path at 2.1.226, and the bundle
 * ships both sides of the protocol). It is a fact about that release, not about
 * that direction.
 *
 * The at-risk class is therefore any subtype whose only evidence in a given version
 * is union membership: it is invisible until the union becomes provable, then dates
 * to that version. This module cannot do better with what the bundle contains.
 *
 * ⚠️ The at-risk records are IDENTIFIABLE, and only here. `evidence` collapses to
 * the highest-ranked signal, so a union-only symbol and a dispatched-and-schema'd
 * one both report `schema`; and `controlMessageConfidence` grades a described schema
 * `high`, which the record contract forbids alongside `first_seen_estimated: true`.
 * So a consumer reading the published record alone cannot tell them apart, and the
 * one place the distinction still exists is this module. `admittedBy` carries it out:
 * `'union'` means `first_seen` is an upper bound. An earlier revision deferred that
 * field as speculative; it is not, because the consumer is the PR that emits these
 * records, and without it a known-wrong date ships at high confidence, unflagged.
 *
 * Emitting the flag is still the consumer's decision, not this module's — this lane
 * reports what it observed and does not grade dating confidence.
 */
export const CONTROL_UNION_FLOOR = '2.1.63';

/**
 * First version that routes anything on `<expr>.request.subtype` at all — the
 * bottom of the era this lane dates the surface from.
 *
 * Below the union floor there is no union to check, but the dispatch signal still
 * works and is the ONLY evidence available: measured, 1.0.44 yields 0 symbols and
 * 1.0.45 yields 1, rising to 3 at 1.0.93, 4 at 1.0.110 and 7 at 2.0.30. That
 * matches the independent string measurement that put `"control_request"` at
 * 1.0.45, so two instruments agree on this boundary.
 */
export const CONTROL_DISPATCH_FLOOR = '1.0.45';

/**
 * First version whose control-request union splits into two disjoint sub-unions,
 * one per direction. Below this the split does not exist and `direction` is
 * unobservable for every record — reported as null, never borrowed from a later
 * release.
 *
 * ⚠️ Null does NOT mean "older than this floor". A subtype that belongs to no
 * directional sub-union is null at ANY version — that is every subtype evidenced
 * only by a call site or a dispatch, `remote_control` included. The schema's
 * `direction` description states both cases; keep the two in step.
 */
export const CONTROL_SPLIT_FLOOR = '2.1.133';

/**
 * Prose anchors from the sub-unions' own `.describe()` text. The bundle states
 * each side in English — "Control requests the agent loop originates …" versus
 * "Control requests a client sends to drive the loop …" — which is positive
 * evidence and the only reliable signal available.
 *
 * Call sites cannot substitute: the bundle ships BOTH sides of the protocol (the
 * SDK lets a JS program act as the host), so both signals appear on both sides.
 * Measured on 2.1.226, per sub-union, as outbound construction (a `subtype`
 * literal inside a `request`/`send` call) over inbound dispatch (the
 * `<expr>.request.subtype` path of the 34/35 above): the 7-member cli_to_host
 * union scores 7/7 and 7/7, the 35-member host_to_cli union 29/35 and 34/35.
 * Neither signal separates them: the plausible rule "constructed here means
 * cli_to_host" labels 36 of the 42 subtypes cli_to_host, including 29 of the 35
 * that are not.
 */
const LOOP_ORIGINATES = 'the agent loop originates';
const CLIENT_SENDS = 'a client sends to drive the loop';

/** Which side of the channel sends a message; null when unobservable. */
export type ControlDirection = 'host_to_cli' | 'cli_to_host' | null;

/** How strongly the bundle evidences a subtype. */
export type ControlEvidence = 'schema' | 'call_site' | 'dispatch';

/**
 * Which of the two admission signals proved this subtype belongs. `belongs` is
 * their union, so every published symbol carries one of these three.
 */
export type ControlAdmission = 'union' | 'dispatch' | 'both';

/** One control-request subtype as observed in a single bundle. */
export interface ControlMessageObservation {
  symbol: string;
  family: 'control_request';
  direction: ControlDirection;
  /** The schema object's own `.describe()` text; empty when it has none. */
  description: string;
  evidence: ControlEvidence;
  /**
   * Which signal admitted this symbol — NOT how strongly the bundle evidences
   * it, which is `evidence`. The two differ in the case that matters: a subtype
   * can carry a described schema (`evidence: 'schema'`, graded `high`) and still
   * owe its admission entirely to union membership.
   *
   * `'union'` alone makes `first_seen` an UPPER BOUND. Such a subtype may have
   * been declared in earlier releases and been invisible there, because a union
   * only admits once the CLI demonstrably routes it — `hook_callback` is
   * declared at 2.1.62 and first published at 2.1.63 for exactly this reason.
   * See CONTROL_UNION_FLOOR.
   *
   * A consumer that dates records MUST read this rather than `evidence`, which
   * collapses to the highest-ranked signal and cannot distinguish the two.
   */
  admittedBy: ControlAdmission;
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
 * Parses as a module, falling back to script. npm-era `cli.js` is ESM while the
 * Bun-embedded bundle is CJS-wrapped, so both have to be reachable — but the
 * order is not arbitrary. oxc recovers from errors rather than bailing at the
 * first `import`, so a failed attempt costs a FULL parse of a ~20 MB bundle.
 * Measured: `module` parses both formats with zero errors (2.1.226 Bun bundle
 * 505 ms, 2.1.112 npm bundle 349 ms), whereas `script` fails the npm format with
 * 10 errors after 414 ms. Module-first therefore costs one parse per version;
 * script-first cost two for all 380 npm-era releases.
 */
function parse(source: string): Node {
  let best: { errors: unknown[]; program: Node } | undefined;
  for (const sourceType of ['module', 'script'] as const) {
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

/**
 * Every object literal carrying a `subtype`, plus every dispatch comparison
 * against one. Enum-shaped subtypes (shape 4) are deliberately collected too, so
 * the family filter can drop them explicitly rather than by silent omission.
 */
function collectCandidates(parents: Map<Node, Node | null>): {
  candidates: Candidate[];
  schemaVariable: Map<string, string>;
} {
  const candidates: Candidate[] = [];
  const schemaVariable = new Map<string, string>();

  for (const node of parents.keys()) {
    if (node.type === 'ObjectExpression') {
      const property = findProperty(node, 'subtype');
      if (property) collectFromObject(node, property, parents, candidates, schemaVariable);
      continue;
    }
    if (node.type === 'BinaryExpression' && (node.operator === '===' || node.operator === '==')) {
      const dispatched = dispatchedName(node);
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
function dispatchedName(node: Node): { symbol: string; onRequestPath: boolean } | undefined {
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
  // `<expr>.request.subtype` read structurally. A regex over the source slice
  // would work on minified input and quietly stop working on anything with a
  // space or comment between the dots, and it assumes the parser's offsets index
  // the string the same way `slice` does.
  const object = member.object;
  const onRequestPath =
    isNode(object) &&
    object.type === 'MemberExpression' &&
    (object.property as Node)?.name === 'request';
  return { symbol: literal.value, onRequestPath };
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
    // A binding site ENDS the walk either way. Falling through a declarator whose
    // id is a pattern, or an assignment to a member expression, would keep hopping
    // outward and bind the schema to some enclosing declarator that is not its
    // binding at all — which then reads as a union member.
    if (current.type === 'VariableDeclarator') {
      const id = current.id;
      return isNode(id) && id.type === 'Identifier' ? (id.name as string) : undefined;
    }
    if (current.type === 'AssignmentExpression') {
      const target = current.left;
      return isNode(target) && target.type === 'Identifier' ? (target.name as string) : undefined;
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
    // Only a union the CLI routes as control requests may name a direction. A
    // system-message union whose prose happened to contain an anchor would
    // otherwise vote on symbols it does not own.
    if (!union.isControlRequest) continue;
    let side: ControlDirection = null;
    if (union.description.includes(LOOP_ORIGINATES)) side = 'cli_to_host';
    else if (union.description.includes(CLIENT_SENDS)) side = 'host_to_cli';
    if (!side) continue;
    for (const member of union.members) {
      const existing = directions.get(member);
      // Last-wins would decide the published direction by AST order, which is a
      // property of the minifier's output rather than of the protocol — so it
      // could flip between adjacent releases with no protocol change. Refuse
      // instead: two unions disagreeing is a shape this module does not model.
      if (existing && existing !== side) {
        throw new Error(
          `control lane: "${member}" is claimed by both a ${existing} and a ${side} ` +
            'union. Direction would be decided by AST order, which is not stable ' +
            'across builds — refusing to publish either.'
        );
      }
      directions.set(member, side);
    }
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
 * Throws rather than returning an empty array at or above CONTROL_DISPATCH_FLOOR:
 * downstream, zero symbols reads as every symbol having been removed at once. The
 * union and split floors carry their own guards on top of that — see the three
 * checks at the end of this function.
 */
export function extractControlMessages(
  source: string,
  version: string
): ControlMessageObservation[] {
  const program = parse(source);
  const parents = indexParents(program);
  const { candidates, schemaVariable } = collectCandidates(parents);

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

  // Which side of that union admitted it. Recorded per symbol because it is the
  // only place the distinction exists: downstream, `evidence` has already
  // collapsed to the highest-ranked signal and a union-only admission is
  // indistinguishable from a dispatched-and-schema'd one.
  const admissionOf = (symbol: string): ControlAdmission => {
    const byUnion = controlMembers.has(symbol);
    const byDispatch = requestDispatched.has(symbol);
    return byUnion && byDispatch ? 'both' : byUnion ? 'union' : 'dispatch';
  };

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
      // Not merged: admission is a property of the symbol, not of the candidate
      // occurrence, so every occurrence resolves to the same value.
      admittedBy: admissionOf(candidate.symbol),
    });
  }

  const result = [...observations.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  // Three guards, one per way this can fail, because `belongs` is a UNION of two
  // independent signals: a final-count check alone fires only if both die in the
  // same release, and either dying alone is silent and wrong.
  //
  // Unions die, dispatch survives (a `union([...])` → `discriminatedUnion(...)`
  // refactor replaces the array with an object map): the call-site-only subtypes
  // vanish — `remote_control` among them — and every direction flips to null.
  if (compareVersionsAsc(version, CONTROL_UNION_FLOOR) >= 0 && controlMembers.size === 0) {
    throw new Error(
      `control lane: no control_request union at ${version}, at or above the ` +
        `${CONTROL_UNION_FLOOR} union floor. Dispatch evidence alone would still ` +
        'publish a plausible-looking set, minus every call-site-only subtype and ' +
        'with every direction nulled. Refusing.'
    );
  }

  // The prose anchors die (Anthropic rewords a `.describe()`): the affected side's
  // subtypes all publish null, which is indistinguishable from the legitimate null
  // carried by a subtype that belongs to no directional union — so a consumer has
  // no way to tell a reworded bundle from a call-site-only record.
  if (compareVersionsAsc(version, CONTROL_SPLIT_FLOOR) >= 0) {
    // BOTH sides, not a non-empty map. Each side comes from its own anchor phrase,
    // so rewording one leaves the other populating the map — the count check would
    // pass while that sub-union's subtypes all published null.
    const sides = new Set([...directions.values()]);
    const missing = (['host_to_cli', 'cli_to_host'] as const).filter((d) => !sides.has(d));
    if (missing.length > 0) {
      throw new Error(
        `control lane: no ${missing.join(' and no ')} union at ${version}, at or above ` +
          `the ${CONTROL_SPLIT_FLOOR} split floor. Every subtype on that side would ` +
          'publish null, indistinguishable from the null a call-site-only subtype ' +
          'legitimately carries — so the loss would be invisible in the output. The ' +
          'union description this reads has probably been reworded.'
      );
    }
  }

  // Every guard above is gated at or above a floor, which left the dispatch era —
  // 1.0.45 up to the union floor — unguarded. That is the era that supplies
  // `first_seen` for the whole surface, so a silent [] there dates everything from
  // the union floor instead: the single most damaging output this module can produce.
  if (result.length === 0 && compareVersionsAsc(version, CONTROL_DISPATCH_FLOOR) >= 0) {
    throw new Error(
      `control lane: no control_request subtypes found at ${version}, at or above the ` +
        `${CONTROL_DISPATCH_FLOOR} dispatch floor. Refusing to report zero — downstream ` +
        'that reads as every subtype being removed in one release, and in this era it ' +
        'would date the entire surface from a later version.'
    );
  }
  return result;
}
