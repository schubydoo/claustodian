// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — the hook events (`PreToolUse`, `SessionStart`, ...), the points in a
 * session where a hook from the `hooks` setting can run.
 *
 * One array literal lists every event the settings schema accepts, as bare string
 * literals in lifecycle order:
 *
 *   1.0.23   fxA=["PreToolUse","PostToolUse","Notification"]
 *   2.1.312  qd=["PreToolUse","PostToolUse","PostToolUseFailure","PostToolBatch", …]
 *
 * THE LIST IS THE EVIDENCE. Each literal in it is one event, and leaving it is a
 * removal: `InstructionsLoaded` is in the list at 2.1.64, out of it at 2.1.66 to 2.1.68
 * (the name is absent from those bundles entirely), and back at 2.1.69, the release
 * that announces it.
 *
 * WHICH ARRAY. The bundle also holds smaller lists of the same names, such as the events
 * that take a tool matcher, and later releases carry the full list twice (the SDK types
 * repeat it). So the list is the largest array whose every element is an event-shaped
 * string literal and which names both `PreToolUse` and `PostToolUse`, and every copy of
 * that size must hold the same names. Every other array that names `PreToolUse` as a
 * literal, whatever else it holds, must name no event outside the list. That catches a
 * list that changes shape: the old subsets would otherwise pass as the whole list, and
 * the events only the new shape names would read as removed. The 2.1.242 mods event
 * array is such an array, with spreads and dotted names, and it passes.
 *
 * FLOOR. The list first ships in HOOK_EVENT_FLOOR. Below it the lane asserts nothing.
 * At or after it, no list throws, because downstream zero events reads as every event
 * removed at once.
 *
 * COST. This lane does no parsing of its own in the cache writers: it reads each chunk's
 * AST through `extractControlMessages`'s `onProgram` callback, as the mod lane does.
 */
import { compareVersionsAsc } from './lib.js';
import { parse, walk, type Node } from './control-lane.js';

/** First release whose bundle carries the hook event list. */
export const HOOK_EVENT_FLOOR = '1.0.23';

/** A hook event's name: `PreToolUse`, `SessionStart`. */
const HOOK_EVENT_NAME = /^[A-Z][A-Za-z]*$/;

/** One chunk's evidence: each candidate list, and the events of every other array. */
export interface HookEvidence {
  /** Arrays of event names only, naming both `PreToolUse` and `PostToolUse`. */
  lists: string[][];
  /** The event-shaped literals of each other array that names `PreToolUse`. */
  others: string[][];
}

function literalString(node: Node | null): string | undefined {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

/** One walk over `program` for every array that names `PreToolUse` as a literal. */
export function collectHookEvidence(program: Node): HookEvidence {
  const lists: string[][] = [];
  const others: string[][] = [];
  walk(program, (node) => {
    if (node.type !== 'ArrayExpression') return;
    const elements = node.elements as Array<Node | null>;
    const values = elements.map(literalString);
    if (!values.includes('PreToolUse')) return;
    const events = values.filter(
      (value): value is string => value !== undefined && HOOK_EVENT_NAME.test(value)
    );
    if (events.length === elements.length && events.includes('PostToolUse')) lists.push(events);
    else others.push(events);
  });
  return { lists, others };
}

/** The events one release lists, sorted. See the module comment for the rules. */
export function hookEventsFrom(evidence: readonly HookEvidence[], version: string): string[] {
  if (compareVersionsAsc(version, HOOK_EVENT_FLOOR) < 0) return [];
  const lists = evidence.flatMap((chunk) => chunk.lists);
  if (lists.length === 0) {
    throw new Error(
      `hook lane: ${version} has no hook event list, and every release since ` +
        `${HOOK_EVENT_FLOOR} has one. Refusing to report zero events, which would read ` +
        'as every event removed at once.'
    );
  }
  const size = Math.max(...lists.map((list) => new Set(list).size));
  const largest = lists.filter((list) => new Set(list).size === size);
  const events = new Set(largest[0]);
  if (largest.some((list) => list.some((name) => !events.has(name)))) {
    throw new Error(
      `hook lane: ${version} has ${largest.length} hook event lists of ${size} names that ` +
        'disagree. The rule can no longer tell which one is the list; read the bundle and ' +
        'tighten collectHookEvidence.'
    );
  }
  const outside = new Set(
    [...lists, ...evidence.flatMap((chunk) => chunk.others)]
      .flat()
      .filter((name) => !events.has(name))
  );
  if (outside.size > 0) {
    throw new Error(
      `hook lane: ${version} names ${[...outside].sort().join(', ')} beside PreToolUse in an ` +
        'array, but not in the hook event list. The list may have changed shape; read the ' +
        'bundle and teach collectHookEvidence the new one.'
    );
  }
  return [...events].sort();
}

/** Parses and extracts in one call, for tests and archive sweeps; see hookEventsFrom. */
export const extractHookEvents = (source: string | readonly string[], version: string): string[] =>
  hookEventsFrom(
    (typeof source === 'string' ? [source] : source).map((src) => collectHookEvidence(parse(src))),
    version
  );
