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
      'ultrareview',
    ]);
    expect(scopesFor('cli_flag', '--all')).toEqual(['agents', 'plugin disable', 'project purge']);
    expect(scopesFor('cli_flag', '--config')).toEqual(['gateway', 'plugin install']);
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
      'plugin prune',
      'plugin uninstall',
      'plugin update',
    ]);
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

  it('never lists a path together with a strict prefix of it', () => {
    // `['plugin', 'plugin eval']` would be self-contradictory: the bare parent
    // claims the flag works at `claude plugin`, which is what the sub-path
    // denies. Catches a half-applied refinement.
    for (const [flag, scopes] of SYMBOL_SCOPES) {
      for (const a of scopes) {
        for (const b of scopes) {
          if (a !== b && b.startsWith(`${a} `)) {
            throw new Error(`${flag}: "${a}" is a strict prefix of "${b}"`);
          }
        }
      }
    }
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
