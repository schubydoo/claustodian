// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  extractBundleSymbols,
  extractCommands,
  extractEnvVars,
  extractFlags,
} from './extract-bundle.js';

describe('extractEnvVars', () => {
  it('captures process.env.X and process.env["X"] with a category', () => {
    const src = 'if(process.env.CLAUDE_CODE_FOO)x();let y=process.env["ANTHROPIC_BAR"];';
    const env = extractEnvVars(src);
    expect(env.get('CLAUDE_CODE_FOO')).toBe('claude-code');
    expect(env.get('ANTHROPIC_BAR')).toBe('claude-code');
  });

  it('categorizes third-party env vars by prefix', () => {
    const env = extractEnvVars('process.env.NODE_OPTIONS,process.env.AWS_REGION,process.env.TERM');
    expect(env.get('NODE_OPTIONS')).toBe('runtime');
    expect(env.get('AWS_REGION')).toBe('cloud');
    expect(env.get('TERM')).toBe('terminal');
  });

  it('drops denylisted false positives (errno codes, format names)', () => {
    const env = extractEnvVars('process.env.ENOENT;process.env.JSON;process.env.CLAUDE_REAL');
    expect(env.has('ENOENT')).toBe(false);
    expect(env.has('JSON')).toBe(false);
    expect(env.has('CLAUDE_REAL')).toBe(true);
  });
});

describe('extractFlags — positive evidence only', () => {
  it('includes flags registered with commander (.option / .addOption)', () => {
    const src = '.option("--fallback-model <m>","use m").addOption(new e7("--mcp-debug"))';
    const flags = extractFlags(src);
    expect(flags.get('--fallback-model')).toBe('registration');
    expect(flags.get('--mcp-debug')).toBe('registration');
  });

  it('includes flags read from a process.argv membership check', () => {
    const src =
      'if(process.argv.includes("--print"))x();const i=process.argv.slice(2).indexOf("--verbose");';
    const flags = extractFlags(src);
    expect(flags.get('--print')).toBe('argv');
    expect(flags.get('--verbose')).toBe('argv');
  });

  it('does not treat a flag merely near an unrelated process.argv read as own', () => {
    // process.argv.slice(2) is not a membership check for --abbrev-ref, which is
    // a git subprocess arg — it must not be emitted with argv evidence
    const src = 'let n=process.argv.slice(2);spawn(g,["rev-parse","--abbrev-ref","HEAD"]);';
    expect(extractFlags(src).has('--abbrev-ref')).toBe(false);
  });

  it('EXCLUDES flags passed to a subprocess (no own-evidence)', () => {
    // git args array and a browser flag map — the exact minified shapes from the
    // real bundle; neither carries registration or argv evidence.
    const src = 'await w1(D7(),["rev-parse","--abbrev-ref","--symbolic-full-name"]);' + 'let $={chrome:"--incognito",brave:"--incognito",firefox:"--private-window"};';
    const flags = extractFlags(src);
    expect(flags.has('--abbrev-ref')).toBe(false);
    expect(flags.has('--symbolic-full-name')).toBe(false);
    expect(flags.has('--incognito')).toBe(false);
    expect(flags.has('--private-window')).toBe(false);
  });

  it('keeps a dual-use flag that also appears as a subprocess arg', () => {
    // first occurrence is a subprocess arg, a later one is a real registration
    const src = 'spawn(g,["log","--format"]);/*...*/.option("--format <f>","output format")';
    expect(extractFlags(src).get('--format')).toBe('registration');
  });

  it('does not re-scan a flag already confirmed as own', () => {
    // registered first, then reappears — the second occurrence is skipped
    const flags = extractFlags('.option("--verbose","desc");const x=["--verbose"];');
    expect(flags.get('--verbose')).toBe('registration');
    expect(flags.size).toBe(1);
  });
});

describe('extractCommands — registry objects', () => {
  it('reads slash commands with their description from the registry', () => {
    const src =
      '{type:"local-jsx",name:"add-dir",description:"Add a new working directory",argumentHint:"<path>"},' +
      '{type:"local",name:"compact",description:"Clear conversation history"}';
    const cmds = extractCommands(src);
    expect(cmds.get('/add-dir')).toBe('Add a new working directory');
    expect(cmds.get('/compact')).toBe('Clear conversation history');
  });

  it('does not treat an API path or bare "/foo" string as a command', () => {
    const cmds = extractCommands('fetch("/guardrails");let p="/evaluation-jobs";');
    expect(cmds.size).toBe(0);
  });

  it('skips a type marker with no resolvable command name', () => {
    expect(extractCommands('{type:"local",foo:"bar"}').size).toBe(0);
  });

  it('does not fork a namespaced command name with a colon', () => {
    // grammar matches the other lanes ([a-z0-9-]); a `ns:cmd` name is skipped,
    // not truncated to `/ns` or emitted as a divergent `/ns:cmd`.
    expect(extractCommands('{type:"local",name:"model:switch"}').size).toBe(0);
  });

  it('lets a later definition backfill a missing description', () => {
    // two definitions of /dup, far enough apart that neither window reaches the
    // other's fields: the first has no description, the second supplies one.
    const src =
      '{type:"local",name:"dup"}' + 'x'.repeat(600) + '{type:"local",name:"dup",description:"filled in"}';
    expect(extractCommands(src).get('/dup')).toBe('filled in');
  });
});

describe('extractBundleSymbols', () => {
  it('merges all three types, sorted by type then symbol, with evidence', () => {
    const src = [
      '.option("--verbose","v")',
      'process.env.CLAUDE_CODE_X',
      '{type:"local",name:"bug",description:"file a bug"}',
    ].join(';');
    const out = extractBundleSymbols(src);
    expect(out).toEqual([
      { symbol: '--verbose', type: 'cli_flag', category: 'cli', evidence: 'registration' },
      { symbol: '/bug', type: 'command', category: 'command', evidence: 'command-registry', description: 'file a bug' },
      { symbol: 'CLAUDE_CODE_X', type: 'env_var', category: 'claude-code', evidence: 'process-env' },
    ]);
  });

  it('omits the description field for a command that has none', () => {
    const out = extractBundleSymbols('{type:"local",name:"status"}');
    expect(out).toEqual([
      { symbol: '/status', type: 'command', category: 'command', evidence: 'command-registry' },
    ]);
  });
});
