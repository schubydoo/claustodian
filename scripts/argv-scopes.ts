// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Which invocation a hand-rolled argv parser belongs to.
 *
 * `case"--flag":` labels (FLAG_SWITCH_CASE in extract-bundle.ts) prove a flag is
 * Claude Code's own, but every one of them lives in a SUBCOMMAND's parser — at
 * 2.1.226 all 44 belong to `claude self-hosted-runner` or deeper. Publishing them
 * into a flat namespace would assert `claude --verify` works, which it does not,
 * so isPublishableBinaryFlag has withheld them since PR 121. This module supplies
 * the missing half: the invocation each parser answers to, so the flags can
 * publish WITH their scope instead of being dropped.
 *
 * THE EVIDENCE IS CONTAINMENT, NOT PROXIMITY. esbuild emits each module as
 * `var NS={};ut(NS,{export:()=>impl,…})` followed by that module's bodies, so the
 * headers partition the bundle. A parser and the usage text it prints are the same
 * module by construction. So: segment on the headers, then read the module's own
 * `Usage: claude <path>` string. Nothing here measures a distance or picks a
 * "nearest" anything — the two nearest-binding heuristics this codebase already
 * carries (FLAG_EVIDENCE_WINDOW, MAX_BINDING_DISTANCE) each needed several rounds
 * to bound, and containment sidesteps that class of bug entirely.
 *
 * Measured over 22 releases spanning 0.2.9 → 2.1.226: no module ever held case
 * labels together with more than one distinct usage string, and every module that
 * did hold both matched its live `--help` output exactly (checked against the
 * installed 2.1.226 binary for all three runner parsers).
 *
 * SCOPES ARE FULL INVOCATION PATHS — `self-hosted-runner orchestrator`, not
 * `self-hosted-runner`. Each parser ends in
 * `default:if(o?.startsWith("--"))throw Error(\`unknown flag ${o}\`)`, and the live
 * binary agrees: `claude self-hosted-runner --min-idle` fails with
 * `unknown flag --min-idle` because `--min-idle` is the orchestrator's. Collapsing
 * to the top-level subcommand would publish a claim the binary disproves, which is
 * the same class of error `scopes` was added to fix.
 */

/**
 * An esbuild CJS-namespace module header: `var NS={};<def>(NS,{…})`. The
 * back-reference is what makes this a module boundary rather than any
 * two-argument call — the object being defined must be the one just declared.
 */
const MODULE_HEADER = /var ([A-Za-z_$][\w$]*)=\{\};([A-Za-z_$][\w$]*)\(\1,\{/g;

/**
 * A parser's own usage banner, e.g. `Usage: claude self-hosted-runner orchestrator
 * [options]`. The path is lowercase words and dashes; it stops at the `[options]`
 * placeholder, a newline (real or escaped, since these sit in template literals),
 * or the literal's closing backtick.
 */
const USAGE_BANNER = /Usage:\s*claude\s+([a-z][a-z0-9 -]*?)\s*(?:\[|\\n|\n|`)/g;

/** A `case"--flag":` label — must stay in step with extract-bundle's copy. */
const CASE_LABEL = /case\s*(["'`])(--[A-Za-z][A-Za-z0-9-]*)\1\s*:/g;

/** Index of the last module header at or before `offset`, or -1 before the first. */
function moduleIndexAt(headers: readonly number[], offset: number): number {
  let lo = 0;
  let hi = headers.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = headers[mid];
    if (at !== undefined && at <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Scopes for every switch-case flag whose scope is COMPLETE, keyed by flag.
 *
 * Completeness is the whole contract of the published `scopes` field: a non-empty
 * list also asserts "not accepted on bare `claude`". So a flag is included only
 * when EVERY case label bearing its name sits in a module carrying exactly one
 * usage banner. One unscoped or ambiguous occurrence and the flag is omitted
 * entirely — a partial scope is worse than none, because it reads as a complete one.
 *
 * `--help` is why that guard is written as a rule rather than left to chance. It
 * is a case label in `self-hosted-runner decode-token` AND in the `/plugin`
 * slash-command parser (a module with no banner, because a slash command has no
 * `claude` invocation). Scoping it to decode-token would publish that
 * `claude --help` does not work. The unscoped occurrence disqualifies it.
 *
 * Returns an empty map for every release before 2.1.224, and for the npm-bundle
 * era whose few modules carry no banners at all — absence yields no scope, which
 * leaves those flags withheld exactly as they are today.
 */
export function extractSwitchCaseScopes(src: string): Map<string, string[]> {
  const headers: number[] = [];
  for (const m of src.matchAll(MODULE_HEADER)) {
    headers.push(m.index);
  }

  const bannersByModule = new Map<number, Set<string>>();
  for (const m of src.matchAll(USAGE_BANNER)) {
    // USAGE_BANNER group 1 is non-optional, so a match always populates it.
    const path = m[1]!;
    const mod = moduleIndexAt(headers, m.index);
    let set = bannersByModule.get(mod);
    if (!set) bannersByModule.set(mod, (set = new Set()));
    set.add(path);
  }

  const modulesByFlag = new Map<string, Set<number>>();
  for (const m of src.matchAll(CASE_LABEL)) {
    // CASE_LABEL group 2 is non-optional, so a match always populates it.
    const flag = m[2]!;
    let set = modulesByFlag.get(flag);
    if (!set) modulesByFlag.set(flag, (set = new Set()));
    set.add(moduleIndexAt(headers, m.index));
  }

  const out = new Map<string, string[]>();
  for (const [flag, modules] of modulesByFlag) {
    const scopes = new Set<string>();
    let complete = true;
    for (const mod of modules) {
      // -1 is the text before the first module header. That is a preamble, not a
      // module, so containment proves nothing there: a banner and a parser both
      // landing in it are not thereby related. Treat it as unscoped.
      if (mod < 0) {
        complete = false;
        break;
      }
      const banners = bannersByModule.get(mod);
      // No banner: an unscoped parser (a slash command, or a pre-2.1.224 bundle).
      // More than one: the module bundles several parsers and containment can no
      // longer say which owns the label. Either way the flag's scope is unknown.
      if (banners?.size !== 1) {
        complete = false;
        break;
      }
      for (const b of banners) scopes.add(b);
    }
    if (complete && scopes.size > 0) out.set(flag, [...scopes].sort());
  }
  return out;
}
