// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { SYMBOL_SCOPES, scopesFor } from './symbol-scopes.js';

describe('scopesFor', () => {
  it('returns the scopes for a subcommand-only flag', () => {
    expect(scopesFor('cli_flag', '--sandbox')).toEqual(['remote-control']);
  });

  it('returns every invocation a flag is accepted under, not just one', () => {
    // The case a single-valued `scope` cannot describe.
    expect(scopesFor('cli_flag', '--json')).toEqual([
      'agents',
      'auth status',
      'plugin eval',
      'plugin list',
      'plugin marketplace list',
      'ultrareview',
    ]);
    expect(scopesFor('cli_flag', '--all')).toEqual([
      'agents',
      'plugin disable',
      'project purge',
      'respawn',
    ]);
    expect(scopesFor('cli_flag', '--config')).toEqual(['gateway', 'plugin install']);
  });

  it('carries the background-subcommand scope proved by extractBgSubcommandScopes', () => {
    // `claude respawn <id>|--all` accepts `--all`. It is curated (not published from
    // the binary lane) because `--all` is a commander registration elsewhere and
    // backfill withholds binary scopes from strong-evidence flags. The scope must be
    // a UNION with its commander invocations, never a replacement.
    expect(scopesFor('cli_flag', '--all')).toContain('respawn');
    expect(scopesFor('cli_flag', '--all')).toContain('agents');
  });

  it('records the sub-subcommand that owns a flag, not its parent', () => {
    // commander rejects a sub-subcommand's flag at the parent, so the coarse
    // `['plugin']` these once carried was a false claim, not merely a vague one:
    //   claude plugin --scaffold  -> error: unknown option '--scaffold'
    //   claude plugin --strict    -> error: unknown option '--strict'
    //   claude mcp --header x     -> error: unknown option '--header'
    expect(scopesFor('cli_flag', '--scaffold')).toEqual(['plugin eval']);
    expect(scopesFor('cli_flag', '--strict')).toEqual(['plugin validate']);
    expect(scopesFor('cli_flag', '--header')).toEqual(['mcp add']);
  });

  it('spans commands when one flag is shared across them', () => {
    // `--scope` is the widest: coarse scoping recorded it as `['plugin']` alone,
    // hiding both its real depth and the whole `mcp` half of its surface.
    expect(scopesFor('cli_flag', '--scope')).toEqual([
      'mcp add',
      'mcp add-from-claude-desktop',
      'mcp add-json',
      'mcp remove',
      'plugin disable',
      'plugin enable',
      'plugin install',
      'plugin marketplace add',
      'plugin marketplace remove',
      'plugin prune',
      'plugin uninstall',
      'plugin update',
    ]);
  });

  it('reaches depth three, where the first capture stopped at two', () => {
    // `plugin eval init` and `plugin marketplace {add,list,remove,update}` are the
    // only depth-three invocations at 2.1.226, and a depth-two sweep saw none of
    // them. Three flags therefore shipped an INCOMPLETE list, which under this
    // field's completeness contract is a false "no" on a real invocation:
    //   claude plugin eval init --interactive
    //   claude plugin marketplace list --json
    //   claude plugin marketplace add --scope
    expect(scopesFor('cli_flag', '--interactive')).toEqual(['plugin eval init', 'project purge']);
    expect(scopesFor('cli_flag', '--json')).toContain('plugin marketplace list');
    expect(scopesFor('cli_flag', '--scope')).toContain('plugin marketplace add');
    expect(scopesFor('cli_flag', '--scope')).toContain('plugin marketplace remove');
    // `--sparse` was missed entirely rather than recorded incompletely.
    expect(scopesFor('cli_flag', '--sparse')).toEqual(['plugin marketplace add']);
  });

  it('leaves a HIDDEN top-level flag unscoped, however a subcommand reuses the name', () => {
    // The sweep excludes what bare `claude --help` accepts, but a `.hideHelp()`
    // flag never appears there and so is never excluded. `--remote` is hidden
    // top-level since 1.0.68 as a deprecated alias for `--cloud`, yet
    // `claude plugin tag --remote <name>` exists — so it was published as
    // `['plugin tag']`, asserting `claude --remote` is invalid. It is not:
    // 2.1.226 tests `t === '--cloud' || … || t === '--remote'` in top-level argv.
    expect(scopesFor('cli_flag', '--remote')).toBeUndefined();
    // `--interview` is the same hidden shape without the harm — hidden ON the
    // subcommand it belongs to, so its scope is real.
    expect(scopesFor('cli_flag', '--interview')).toEqual(['plugin eval init']);
  });

  it('scopes the one runner flag the changelog publishes', () => {
    // `claude self-hosted-runner` is argv-dispatched and hidden from
    // `claude --help`, so it was not in the sweep. But 2.1.225's changelog names
    // `--base-dir`, which publishes it through the changelog lane — leaving a
    // runner-only flag in the dataset with no scope at all.
    expect(scopesFor('cli_flag', '--base-dir')).toEqual(['self-hosted-runner']);
  });

  it('leaves a flag accepted on bare claude unscoped', () => {
    // `--help` is attributed to plugins-reference in docs.json purely because no
    // earlier page claimed it. Scoping by page would publish "--help only works
    // under claude plugin", which is worse than saying nothing.
    expect(scopesFor('cli_flag', '--help')).toBeUndefined();
    expect(scopesFor('cli_flag', '--verbose')).toBeUndefined();
    expect(scopesFor('cli_flag', '--model')).toBeUndefined();
  });

  it('scopes only flags — commands, env vars and settings have no subcommand', () => {
    expect(scopesFor('command', '/plugin')).toBeUndefined();
    expect(scopesFor('env_var', 'CLAUDE_CODE_SCOPE')).toBeUndefined();
    expect(scopesFor('config_key', 'model')).toBeUndefined();
    // Even for a name that IS a scoped flag, a non-flag type gets nothing.
    expect(scopesFor('env_var', '--sandbox')).toBeUndefined();
  });

  it('returns undefined for an unknown flag rather than an empty list', () => {
    // Absent means "no scope information", which is distinct from "top-level".
    expect(scopesFor('cli_flag', '--not-a-real-flag')).toBeUndefined();
  });
});

describe('SYMBOL_SCOPES table', () => {
  it('never records an empty scope list', () => {
    // A non-empty list is what carries "not accepted on bare claude"; an empty
    // one would silently assert nothing while looking like it asserts something.
    for (const [flag, scopes] of SYMBOL_SCOPES) {
      expect(scopes.length, `${flag} has an empty scope list`).toBeGreaterThan(0);
    }
  });

  it('keeps every scope list sorted and free of duplicates', () => {
    for (const [flag, scopes] of SYMBOL_SCOPES) {
      expect([...scopes], `${flag} is not sorted`).toEqual([...scopes].sort());
      expect(new Set(scopes).size, `${flag} has duplicates`).toBe(scopes.length);
    }
  });

  it('never lists a path together with a strict prefix of it, unless both are evidenced', () => {
    // Catches a half-applied refinement: recording `['plugin', 'plugin eval']`
    // when only the child was re-derived leaves the parent asserting a scope
    // `claude plugin --scaffold` rejects.
    //
    // ⚠️ A parent and its child TOGETHER is not self-contradictory in general, and
    // the earlier wording here said it was. `--hooks-dir` publishes
    // `["daemon", "self-hosted-runner", "self-hosted-runner orchestrator"]` — the
    // binary lane proved each of those parsers accepts it (scripts/argv-scopes.ts),
    // and listing fewer would be the false claim. It has no entry in THIS map, which
    // is why this test never saw it.
    //
    // So the rule is a curation guard, not a truth about scopes. When a curated
    // flag is genuinely accepted at both a path and its child — an ordinary
    // commander shape for a parent command with its own action — add it here with
    // the evidence rather than deleting a true scope to get green.
    // Keyed by `flag|parent|child`, not by flag: exempting a whole flag would also
    // wave through a second, unrelated prefix pair on it.
    const EVIDENCED_PARENT_AND_CHILD = new Set<string>([]);
    for (const [flag, scopes] of SYMBOL_SCOPES) {
      for (const a of scopes) {
        for (const b of scopes) {
          if (a !== b && b.startsWith(`${a} `)) {
            if (EVIDENCED_PARENT_AND_CHILD.has(`${flag}|${a}|${b}`)) continue;
            throw new Error(
              `${flag}: "${a}" is a strict prefix of "${b}". Usually the parent is a ` +
                `stale coarse path left by a half-applied refinement — drop it. If BOTH ` +
                `are real, add "${flag}|${a}|${b}" to EVIDENCED_PARENT_AND_CHILD. ` +
                `Note \`--help\` cannot settle a hidden or argv-dispatched surface: ` +
                `read the registration in the bundle, as scripts/argv-scopes.ts does.`
            );
          }
        }
      }
    }
  });

  it('publishes a parent and its child together when both are evidenced', () => {
    // The counterexample the invariant above must not be read as forbidding.
    //
    // This is the REAL one: `--hooks-dir` has no curated entry, so `scopesFor`
    // returns the binary scopes sorted, without reaching the union, and
    // `data/binary-observations.json` records exactly these three — a path and two
    // descendants. It is what `data/latest.json` publishes.
    expect(
      scopesFor('cli_flag', '--hooks-dir', [
        'daemon',
        'self-hosted-runner',
        'self-hosted-runner orchestrator',
      ])
    ).toEqual(['daemon', 'self-hosted-runner', 'self-hosted-runner orchestrator']);

    // And the union can produce the same shape from two halves. Synthetic on
    // purpose: no flag today unions into a prefix pair — the curated table and the
    // binary lane happen to agree on `--base-dir` (`self-hosted-runner` from both).
    // The invariant must still not forbid it if a future capture splits that way.
    expect(scopesFor('cli_flag', '--base-dir', ['self-hosted-runner orchestrator'])).toEqual([
      'self-hosted-runner',
      'self-hosted-runner orchestrator',
    ]);
  });

  it('only holds long flags', () => {
    for (const flag of SYMBOL_SCOPES.keys()) expect(flag).toMatch(/^--[a-z][a-z0-9-]+$/);
  });
});

describe('scopesFor with binary-proved scopes', () => {
  it('unions curated and binary scopes rather than letting one win', () => {
    // The `claude --help` sweep could not reach `self-hosted-runner` (hidden from
    // help), so it recorded `--capacity` as remote-control's alone. The binary
    // lane sees the runner's parser but never a commander registration. Neither
    // source is complete by itself; the union is.
    expect(scopesFor('cli_flag', '--capacity', ['self-hosted-runner'])).toEqual([
      'remote-control',
      'self-hosted-runner',
    ]);
  });

  it('agrees with itself when both sources say the same thing', () => {
    expect(scopesFor('cli_flag', '--base-dir', ['self-hosted-runner'])).toEqual([
      'self-hosted-runner',
    ]);
  });

  it('returns binary scopes for a flag the curated table never saw', () => {
    expect(scopesFor('cli_flag', '--min-idle', ['self-hosted-runner orchestrator'])).toEqual([
      'self-hosted-runner orchestrator',
    ]);
  });

  it('falls back to the curated table when binary scopes are absent or empty', () => {
    expect(scopesFor('cli_flag', '--sandbox', [])).toEqual(['remote-control']);
    expect(scopesFor('cli_flag', '--sandbox', undefined)).toEqual(['remote-control']);
  });

  it('still scopes nothing but flags, whatever the binary reports', () => {
    expect(scopesFor('command', '/plugin', ['self-hosted-runner'])).toBeUndefined();
    expect(scopesFor('env_var', 'CLAUDE_CODE_X', ['self-hosted-runner'])).toBeUndefined();
  });

  it('leaves an unscoped flag unscoped when the binary proves nothing', () => {
    expect(scopesFor('cli_flag', '--help', undefined)).toBeUndefined();
  });
});
