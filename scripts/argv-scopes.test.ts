// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { extractBgSubcommandScopes, extractSwitchCaseScopes } from './argv-scopes.js';

/** An esbuild module: header, bodies, and whatever usage text it prints. */
const mod = (ns: string, body: string): string => `var ${ns}={};ut(${ns},{main:()=>x});${body}`;

/** A hand-rolled argv parser over `flags`, shaped like the real runner parsers. */
const parser = (flags: readonly string[]): string =>
  `function p(e){for(let l=0;l<e.length;l++){switch(e[l]){` +
  flags.map((f) => `case"${f}":t.x=1;break;`).join('') +
  `default:if(e[l]?.startsWith("--"))throw Error(\`unknown flag \${e[l]}\`)}}}`;

const banner = (path: string): string =>
  `console.log(\`Usage: claude ${path} [options]\n\nDoes a thing.\`)`;

describe('extractSwitchCaseScopes', () => {
  it('scopes a flag to the invocation its own module prints', () => {
    const src = mod('A5h', banner('self-hosted-runner orchestrator') + parser(['--min-idle']));
    expect(extractSwitchCaseScopes(src).get('--min-idle')).toEqual([
      'self-hosted-runner orchestrator',
    ]);
  });

  it('keeps the full invocation path rather than the top-level subcommand', () => {
    // `claude self-hosted-runner --min-idle` fails with `unknown flag --min-idle`
    // because the flag is the orchestrator's. Collapsing to `self-hosted-runner`
    // would publish a claim the binary's own `default:` branch disproves.
    const src = mod('A5h', banner('self-hosted-runner orchestrator') + parser(['--min-idle']));
    expect(extractSwitchCaseScopes(src).get('--min-idle')).not.toContain('self-hosted-runner');
  });

  it('unions the scopes of every parser that accepts the same flag', () => {
    // `--api-url` is a case label in all three runner parsers at 2.1.226.
    const src =
      mod('A5h', banner('self-hosted-runner orchestrator') + parser(['--api-url'])) +
      mod('B5h', banner('self-hosted-runner decode-token') + parser(['--api-url'])) +
      mod('C5h', banner('self-hosted-runner') + parser(['--api-url']));
    expect(extractSwitchCaseScopes(src).get('--api-url')).toEqual([
      'self-hosted-runner',
      'self-hosted-runner decode-token',
      'self-hosted-runner orchestrator',
    ]);
  });

  it('withholds a flag that also appears in a module with no usage banner', () => {
    // THE `--help` CASE, and the reason completeness is a rule and not luck.
    // `--help` is a case label in `self-hosted-runner decode-token` AND in the
    // `/plugin` slash-command parser, which prints no `Usage: claude …` banner
    // because a slash command has no claude invocation. Scoping it to
    // decode-token would publish that `claude --help` does not work.
    const src =
      mod('A5h', banner('self-hosted-runner decode-token') + parser(['--help', '--no-verify'])) +
      mod('B5h', parser(['--help']));
    const scopes = extractSwitchCaseScopes(src);
    expect(scopes.has('--help')).toBe(false);
    // The flag beside it in the same parser is unaffected — the guard is per-flag.
    expect(scopes.get('--no-verify')).toEqual(['self-hosted-runner decode-token']);
  });

  it('withholds a flag whose module carries more than one usage banner', () => {
    // Two parsers bundled into one module: containment can no longer say which
    // one owns the label, so the scope is unknown rather than "probably both".
    const src = mod(
      'A5h',
      banner('self-hosted-runner setup') + banner('self-hosted-runner doctor') + parser(['--force'])
    );
    expect(extractSwitchCaseScopes(src).has('--force')).toBe(false);
  });

  it('returns nothing for a bundle with no usage banners at all', () => {
    // The npm-bundle era (< 2.1.113) emits a handful of modules and no banners.
    // Absence must read as "no scope", leaving those flags withheld as they are
    // today — never as an error and never as a guess.
    expect(extractSwitchCaseScopes(mod('A5h', parser(['--x', '--y']))).size).toBe(0);
  });

  it('returns nothing for a bundle with no switch-case parser', () => {
    expect(extractSwitchCaseScopes(mod('A5h', banner('import') + 'let a=1;')).size).toBe(0);
  });

  it('assigns a label to the module it is inside, not the nearest banner', () => {
    // The distinction the whole approach rests on, and it must defeat BOTH shapes
    // of proximity heuristic — the two this codebase already carries each took
    // several rounds to bound correctly.
    //
    // Modelled on the real bundle, where a module defines its parser BEFORE the
    // main function that prints the banner (`parseOrchestratorArgs` precedes
    // `selfHostedRunnerOrchestratorMain` by ~19k chars at 2.1.226). So for
    // `--min-idle`: the nearest PRECEDING banner is decode-token's, in the
    // previous module — wrong. The nearest banner by absolute distance is also
    // decode-token's — wrong. Containment gives the orchestrator, which is what
    // `claude self-hosted-runner orchestrator --help` actually prints.
    const src =
      mod('B5h', banner('self-hosted-runner decode-token') + parser(['--header'])) +
      mod(
        'A5h',
        parser(['--min-idle']) + 'x'.repeat(4000) + banner('self-hosted-runner orchestrator')
      );
    expect(extractSwitchCaseScopes(src).get('--min-idle')).toEqual([
      'self-hosted-runner orchestrator',
    ]);
  });

  it('does not scope a parser that sits in the preamble beside a banner', () => {
    // Both in the text before the first module header. Containment cannot relate
    // them — the preamble is not a module — so the flag stays unscoped rather
    // than inheriting whatever banner happens to share the region with it.
    const src = banner('daemon') + parser(['--foo']) + mod('A5h', 'let a=1;');
    expect(extractSwitchCaseScopes(src).has('--foo')).toBe(false);
  });

  it('ignores a banner that precedes the first module header', () => {
    // Preamble text belongs to no module. It must not become the scope for a
    // parser that happens to be the first one defined.
    const src = banner('daemon') + mod('A5h', parser(['--foo']));
    expect(extractSwitchCaseScopes(src).has('--foo')).toBe(false);
  });

  it('requires the module header to close over the object it just declared', () => {
    // `var Q={};zz(R,{…})` is an ordinary two-argument call, not a module boundary.
    // The decoy is placed BETWEEN the banner and the parser precisely so that
    // mistaking it for a header splits the module and strands the parser in a
    // bannerless one — without that placement the test passes either way.
    const src = mod(
      'A5h',
      banner('self-hosted-runner') + 'var Q9k={};zz(R4p,{other:()=>y});' + parser(['--capacity'])
    );
    expect(extractSwitchCaseScopes(src).get('--capacity')).toEqual(['self-hosted-runner']);
  });

  it('reads a banner ending at a newline or a backtick, not just at [options]', () => {
    const nl = mod(
      'A5h',
      'console.log(`Usage: claude self-hosted-runner doctor\\n\\nChecks.`)' + parser(['--fix'])
    );
    expect(extractSwitchCaseScopes(nl).get('--fix')).toEqual(['self-hosted-runner doctor']);
    const tick = mod('B5h', 'console.log(`Usage: claude import`)' + parser(['--dry']));
    expect(extractSwitchCaseScopes(tick).get('--dry')).toEqual(['import']);
  });

  it('does not scope a flag whose only case label is in another module', () => {
    const src =
      mod('A5h', banner('self-hosted-runner') + parser(['--capacity'])) +
      mod('B5h', banner('import') + 'let a=1;');
    const scopes = extractSwitchCaseScopes(src);
    expect(scopes.get('--capacity')).toEqual(['self-hosted-runner']);
    expect(scopes.size).toBe(1);
  });
});

/** A background-session subcommand parser: one positional, and an "unknown option"
 *  guard that rejects every dash-led token except `flags`, printing its own usage
 *  banner inside that guard block — the real `respawn`/`rm`/… shape. */
const bgParser = (path: string, flags: readonly string[]): string => {
  const usage = `Usage: claude ${path} <id>${flags.map((f) => `|${f}`).join('')}`;
  const chain = flags.map((f) => `&&e!=="${f}"`).join('');
  return (
    `async function h(e){if(e==="--help"){process.stdout.write(\`${usage}\`);return}` +
    `if(e?.startsWith("-")${chain}){process.stderr.write(\`unknown option '\${e}'\n${usage}\`),process.exitCode=1;return}}`
  );
};

describe('extractBgSubcommandScopes', () => {
  it('scopes a flag from the guard that rejects every other dash-led token', () => {
    // `claude respawn <id>|--all`: the guard proves `--all` is the complete
    // accepted set, and the banner in its own block names the invocation.
    expect(extractBgSubcommandScopes(bgParser('respawn', ['--all'])).get('--all')).toEqual([
      'respawn',
    ]);
  });

  it('reads the path across a `<id>|--all` banner the case-label lane cannot end on', () => {
    // USAGE_BANNER stops the path at `[`, a newline, or a backtick; these banners
    // put `<` right after the path, so the case-label lane never matched them.
    expect([...extractBgSubcommandScopes(bgParser('respawn', ['--all'])).keys()]).toEqual([
      '--all',
    ]);
  });

  it('contributes nothing for a subcommand that accepts no flags', () => {
    // `attach`/`logs`/`stop`/`rm` take only a positional id: the guard has no
    // `!==` exception, so there is no accepted flag to scope.
    expect(extractBgSubcommandScopes(bgParser('rm', [])).size).toBe(0);
  });

  it('scopes every flag named in the guard chain', () => {
    const scopes = extractBgSubcommandScopes(bgParser('x', ['--all', '--force']));
    expect(scopes.get('--all')).toEqual(['x']);
    expect(scopes.get('--force')).toEqual(['x']);
  });

  it('unions the subcommands that accept the same flag', () => {
    const src = bgParser('respawn', ['--all']) + bgParser('prune', ['--all']);
    expect(extractBgSubcommandScopes(src).get('--all')).toEqual(['prune', 'respawn']);
  });

  it('ignores a generic startsWith("-") check with no accepted flag and no banner', () => {
    // The ordinary arg guards elsewhere in the bundle: no `!==` exception, no usage
    // string — they must not manufacture a scope.
    expect(extractBgSubcommandScopes('if(o?.startsWith("-")){throw Error("bad")}').size).toBe(0);
  });

  it('reads a multi-word invocation path', () => {
    expect(
      extractBgSubcommandScopes(bgParser('plugin marketplace add', ['--scope'])).get('--scope')
    ).toEqual(['plugin marketplace add']);
  });
});
