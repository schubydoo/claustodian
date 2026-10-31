// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — the Claude models the CLI knows, by first-party API id
 * (`claude-3-7-sonnet-20250219`, `claude-opus-5-5`).
 *
 * THE ID IS THE IDENTITY. It is the one name every era writes. The registry from
 * REGISTRY_FLOOR also carries a short id (`claude-sonnet-4-5`), but keying on it would
 * date every older model to the registry's arrival and read a short-id rename as a
 * removal. Bedrock, Vertex and other provider ids are not read.
 *
 * TWO SHAPES. Before the registry, each model has a provider object:
 *
 *   0.2.61   f10={bedrock:"us.anthropic.claude-3-7-sonnet-20250219-v1:0",vertex:"…",firstParty:"claude-3-7-sonnet-20250219"}
 *   0.2.62   O10="claude-3-7-sonnet-20250219",S10={firstParty:O10,bedrock:"…",vertex:"…"}
 *
 * From REGISTRY_FLOOR, each model has a registry entry, whose `display_name`, when it
 * has one, becomes the description:
 *
 *   2.1.316  {id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",…,provider_ids:{first_party:"claude-opus-5-5",…},…}
 *
 * The id can be a variable, as at 0.2.62, so it resolves through the lexical scope,
 * never by spelling. Provider objects are read up to and including REGISTRY_FLOOR, the
 * one release with both shapes: `claude-mythos-5` has a provider object from 2.1.170
 * and joins the registry only at 2.1.196. After REGISTRY_FLOOR the provider objects are
 * gone, and other objects reuse their keys for adapters (`firstParty:t.first_party`),
 * limits (`firstParty:2000`) and flags (`firstParty:!0`), so only the registry counts.
 *
 * WHAT IS NOT A MODEL. `retirementDates:{firstParty:"June 15, 2026",bedrock:…}` has a
 * provider object's keys, and so does a provider entry set to null. A date and a null are
 * skipped. Any other value that is not a model-shaped id string throws, because it could
 * hide a model and publish it as removed.
 *
 * FLOORS. Every archived release names at least one model, so zero throws. From
 * REGISTRY_FLOOR, fewer than MIN_REGISTRY_ENTRIES registry entries throws: the registry
 * is where every later model lands. A model whose entries give two display names in one
 * release throws.
 *
 * COST. This lane does no parsing of its own in the cache writers: it reads each chunk's
 * AST through `extractControlMessages`'s `onProgram` callback, as the mod lane does.
 */
import { compareVersionsAsc } from './lib.js';
import { isNode, parse, type Node } from './control-lane.js';
import { lookup, walkScopes, type Scope } from './js-scope.js';

/** First archived release; every release from it names a model. */
export const MODEL_FLOOR = '0.2.9';

/** First release whose bundle carries the model registry. */
export const REGISTRY_FLOOR = '2.1.195';

/** The fewest registry entries a release from REGISTRY_FLOOR may have. It had 14 there. */
const MIN_REGISTRY_ENTRIES = 10;

/** A first-party model id: `claude-opus-5-5`, `claude-3-7-sonnet-20250219`. */
const MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A retirement date, the one non-id string a provider object's keys carry: `June 15, 2026`. */
const DATE = /^[A-Z][a-z]+ \d{1,2}, \d{4}$/;

/** One model a release names, with its registry display name when it has one. */
export interface ModelObservation {
  id: string;
  name?: string;
}

/** One chunk's evidence. */
export interface ModelEvidence {
  /** Each model id, from either shape, with the registry's display name. */
  models: Array<ModelObservation & { registry: boolean }>;
  /** A note for each id value this lane cannot resolve to a string. */
  unreadable: Array<{ note: string; registry: boolean }>;
}

/** The value of a non-computed property named `name`, else undefined. */
function propertyValue(object: Node, name: string): Node | undefined {
  for (const p of object.properties as Node[]) {
    if (p.type !== 'Property' || p.computed === true) continue;
    const key = p.key as Node;
    if ((key.type === 'Identifier' ? key.name : key.value) === name) return p.value as Node;
  }
  return undefined;
}

/**
 * The string a value is, following a variable to its declaration; null for a literal
 * null; undefined when the lane cannot tell.
 */
function stringOf(value: Node, scope: Scope): string | null | undefined {
  if (value.type === 'Literal') {
    if (value.value === null) return null;
    return typeof value.value === 'string' ? value.value : undefined;
  }
  if (value.type !== 'Identifier') return undefined;
  const binding = lookup(value.name as string, scope);
  const init = binding?.init;
  return binding && isNode(init) ? stringOf(init, binding.scope) : undefined;
}

/** One walk over `program` for both shapes. Names resolve once the walk has ended. */
export function collectModelEvidence(program: Node): ModelEvidence {
  const sites: Array<{ id: Node; name?: Node; registry: boolean; scope: Scope }> = [];
  walkScopes(program, (node, scope) => {
    if (node.type !== 'ObjectExpression') return;
    const firstParty = propertyValue(node, 'firstParty');
    if (firstParty && propertyValue(node, 'bedrock')) {
      sites.push({ id: firstParty, registry: false, scope });
    }
    const providers = propertyValue(node, 'provider_ids');
    const registryId =
      providers?.type === 'ObjectExpression' ? propertyValue(providers, 'first_party') : undefined;
    if (registryId) {
      sites.push({
        id: registryId,
        name: propertyValue(node, 'display_name'),
        registry: true,
        scope,
      });
    }
  });
  const models: ModelEvidence['models'] = [];
  const unreadable: ModelEvidence['unreadable'] = [];
  for (const site of sites) {
    const id = stringOf(site.id, site.scope);
    if (id === undefined) {
      unreadable.push({
        note: `a first-party id written as a ${site.id.type}`,
        registry: site.registry,
      });
      continue;
    }
    if (id === null || DATE.test(id)) continue;
    if (!MODEL_ID.test(id)) {
      unreadable.push({ note: `a first-party id "${id}"`, registry: site.registry });
      continue;
    }
    const name = site.name ? stringOf(site.name, site.scope) : undefined;
    if (site.name && typeof name !== 'string') {
      unreadable.push({
        note: `the display name of ${id}, written as a ${site.name.type}`,
        registry: true,
      });
      continue;
    }
    models.push({ id, ...(name ? { name } : {}), registry: site.registry });
  }
  return { models, unreadable };
}

/** The models one release names, sorted by id. See the module comment for the rules. */
export function modelsFrom(
  evidence: readonly ModelEvidence[],
  version: string
): ModelObservation[] {
  if (compareVersionsAsc(version, MODEL_FLOOR) < 0) return [];
  const providers = compareVersionsAsc(version, REGISTRY_FLOOR) <= 0;
  const counted = <T extends { registry: boolean }>(items: T[]) =>
    items.filter((item) => providers || item.registry);
  const unreadable = counted(evidence.flatMap((chunk) => chunk.unreadable));
  if (unreadable.length > 0) {
    throw new Error(
      `model lane: ${version} holds ${unreadable.map((u) => u.note).join(', ')}, which this ` +
        'lane cannot read. Read the bundle and teach collectModelEvidence the new shape.'
    );
  }
  const all = counted(evidence.flatMap((chunk) => chunk.models));
  const registry = new Set(all.filter((m) => m.registry).map((m) => m.id));
  if (compareVersionsAsc(version, REGISTRY_FLOOR) >= 0 && registry.size < MIN_REGISTRY_ENTRIES) {
    throw new Error(
      `model lane: ${version} has ${registry.size} model registry entries, and every ` +
        `release since ${REGISTRY_FLOOR} has at least ${MIN_REGISTRY_ENTRIES}. Refusing to ` +
        'report a short list, which would read as models removed.'
    );
  }
  if (all.length === 0) {
    throw new Error(
      `model lane: ${version} names no model, and every release since ${MODEL_FLOOR} names ` +
        'one. Refusing to report zero models, which would read as every model removed.'
    );
  }
  const names = new Map<string, string | undefined>();
  for (const { id, name } of all) {
    const known = names.get(id);
    if (name !== undefined && known !== undefined && known !== name) {
      throw new Error(
        `model lane: ${version} gives ${id} two display names, "${known}" and "${name}". ` +
          'Read the bundle and decide which entry is the registry.'
      );
    }
    names.set(id, known ?? name);
  }
  return [...names]
    .map(([id, name]) => ({ id, ...(name ? { name } : {}) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Parses and extracts in one call, for tests and archive sweeps; see modelsFrom. */
export const extractModels = (
  source: string | readonly string[],
  version: string
): ModelObservation[] =>
  modelsFrom(
    (typeof source === 'string' ? [source] : source).map((src) => collectModelEvidence(parse(src))),
    version
  );
