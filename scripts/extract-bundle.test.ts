// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { isAccessorEvidenceEnv, isPublishableBinaryEnv } from './binary-lane.js';
import {
  extractHiddenFlags,
  extractAccessorEnvVars,
  extractBundleSymbols,
  extractCommands,
  extractEnvVars,
  extractFlagDescriptions,
  extractFlags,
  extractNameReaderEnvVars,
  extractParamEnvVars,
  textAbsent,
  textAbsentFor,
  extractSkillCommands,
  withChildEnvVars,
  withVariableSkills,
} from './extract-bundle.js';

describe('extractFlagDescriptions', () => {
  const known = new Set(['--verbose', '--print', '--mcp-config', '--max-thinking-tokens']);

  it('captures a .option(spec, description) pair for a tracked flag', () => {
    const d = extractFlagDescriptions('.option("--verbose","Override verbose mode")', known);
    expect(d.get('--verbose')).toBe('Override verbose mode');
  });

  it('reads the long flag from a "-p, --print" spec', () => {
    const d = extractFlagDescriptions('.option("-p, --print","Print and exit")', known);
    expect(d.get('--print')).toBe('Print and exit');
  });

  it('handles an arg placeholder in the spec and the minified Option constructor', () => {
    const src =
      '.option("--mcp-config <configs...>","Load MCP servers");new GV("--max-thinking-tokens <n>","Max thinking tokens")';
    const d = extractFlagDescriptions(src, known);
    expect(d.get('--mcp-config')).toBe('Load MCP servers');
    expect(d.get('--max-thinking-tokens')).toBe('Max thinking tokens');
  });

  it('ignores a (spec, desc) pair whose flag is not tracked (no invented descriptions)', () => {
    const d = extractFlagDescriptions('.option("--unknown","x")', known);
    expect(d.has('--unknown')).toBe(false);
  });

  it('drops a flag with two DIFFERENT descriptions in one bundle (subcommand-ambiguous)', () => {
    // `--all` = "Disable all enabled plugins" (plugin disable) AND "Purge state…"
    // (project purge). Can't pick one → record none.
    const d = extractFlagDescriptions(
      '.option("--verbose","Disable all enabled plugins");.option("--verbose","Purge state for every project")',
      known
    );
    expect(d.has('--verbose')).toBe(false);
  });

  it('keeps a flag described identically twice (one distinct description)', () => {
    const d = extractFlagDescriptions(
      '.option("--verbose","Same text");.option("--verbose","Same text")',
      known
    );
    expect(d.get('--verbose')).toBe('Same text');
  });

  it('records no description for a short-only spec (no long flag to attach it to)', () => {
    const d = extractFlagDescriptions('.option("-v","Verbose output")', new Set(['--verbose']));
    expect(d.size).toBe(0);
  });

  it('describes every in-grammar alias in a spec, and never the camelCase phantom', () => {
    // Reading only the spec's FIRST token gave the phantom `--allowed` this exact
    // description and left the real alias undescribed.
    const src = '.option("--allowedTools, [--allowed-tools] <tools...>","Tools to allow")';
    const d = extractFlagDescriptions(src, new Set(['--allowed', '--allowed-tools']));
    expect(d.get('--allowed-tools')).toBe('Tools to allow');
    expect(d.has('--allowed')).toBe(false);
  });

  it('drops a BACKTICK template-literal description (${VAR} churns every release)', () => {
    const d = extractFlagDescriptions('.option("--verbose",`Effort (${UV.join(", ")})`)', known);
    expect(d.has('--verbose')).toBe(false);
  });

  it('keeps a plain double-quoted description that merely contains the text "${"', () => {
    const d = extractFlagDescriptions('.option("--verbose","Use ${name} syntax")', known);
    expect(d.get('--verbose')).toBe('Use ${name} syntax');
  });

  it('unescapes a single pass: an escaped backslash does not become a newline', () => {
    // "C:\\new" — the escaped backslash must stay literal, not turn into \n.
    const d = extractFlagDescriptions(String.raw`.option("--verbose","C:\\new")`, known);
    expect(d.get('--verbose')).toBe('C:\\new');
  });

  it('does not truncate a description containing an apostrophe (delimiter-aware)', () => {
    const d = extractFlagDescriptions('.option("--verbose","Don\'t stop at the quote")', known);
    expect(d.get('--verbose')).toBe("Don't stop at the quote");
  });

  it('unescapes JS string escapes (\\uXXXX, \\n) in the captured description', () => {
    const d = extractFlagDescriptions(String.raw`.option("--verbose","caf\u00e9\nline")`, known);
    expect(d.get('--verbose')).toBe('café\nline');
  });

  it('does not mistake a bare flag array for a spec/description pair', () => {
    // `["--verbose","--input-format"]` must NOT make "--input-format" --verbose's description.
    const d = extractFlagDescriptions('const a=["--verbose","--input-format","--print"];', known);
    expect(d.has('--verbose')).toBe(false);
  });

  it('rejects a description that itself looks like a flag', () => {
    const d = extractFlagDescriptions('.option("--verbose","--print")', known);
    expect(d.has('--verbose')).toBe(false);
  });

  it('attaches the description to the flag symbol in extractBundleSymbols', () => {
    const src = '.option("--verbose","Override verbose mode")';
    const flag = extractBundleSymbols(src).find((s) => s.symbol === '--verbose');
    expect(flag).toMatchObject({ type: 'cli_flag', description: 'Override verbose mode' });
  });
});

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

describe('extractAccessorEnvVars — first-party accessor-map getters', () => {
  // Each map below also holds PROVEN_ENV, a name a read proves, so it is an env map.
  // Each test source has one map, so the key goes in after its one opening brace.
  const proven = new Set(['PROVEN_ENV']);
  const acc = (src: string) => {
    const open = src.indexOf('{') + 1;
    return extractAccessorEnvVars(
      `${src.slice(0, open)}PROVEN_ENV:()=>p,${src.slice(open)}`,
      proven
    );
  };
  it('captures claude-code NAME:()=> getter entries', () => {
    const env = acc('let E={CLAUDE_CODE_FOO:()=>x,ANTHROPIC_BAR:()=>y};');
    expect(env.get('CLAUDE_CODE_FOO')).toBe('claude-code');
    expect(env.get('ANTHROPIC_BAR')).toBe('claude-code');
  });

  it('captures an audited first-party var that skips the CLAUDE_/ANTHROPIC_ convention', () => {
    // PROMOTE_CC_ENV is a human audit saying these ARE Claude Code's own. Gating
    // on the prefix alone dropped them here, so when the inline `process.env`
    // read went away the symbol vanished from extraction and the lane recorded a
    // removal — EMBEDDED_SEARCH_TOOLS, ENABLE_LSP_TOOL and
    // ENABLE_SESSION_PERSISTENCE all carried removed_in while sitting in the tip
    // binary as `NAME:()=>ref`.
    const env = acc('{EMBEDDED_SEARCH_TOOLS:()=>a,ENABLE_LSP_TOOL:()=>b}');
    expect(env.has('EMBEDDED_SEARCH_TOOLS')).toBe(true);
    expect(env.has('ENABLE_LSP_TOOL')).toBe(true);
  });

  it('does NOT admit an ownership-unresolved name on getter shape alone', () => {
    // NEEDS_REVIEW_ENV is "some of these lean external" — it cannot be the
    // evidence that a same-named getter key is an env var rather than one of the
    // constants that make up ~43% of the map. These still publish when the direct
    // `process.env.X` path proves them, which is the signal the audit was over.
    const env = acc('{CLAUBBIT:()=>1,LOCAL_BRIDGE:()=>2,BAT_THEME:()=>3}');
    expect(env.size).toBe(0);
  });

  it('admits a strict subset of what the publish overlay would allow', () => {
    // The accessor gate answers "is this an env var at all"; publication answers
    // "is this env var CC's own". The first must never be the looser of the two.
    const admitted = [
      ...acc('{EMBEDDED_SEARCH_TOOLS:()=>a,NUMBER_FORMAT_RANGES:()=>b,CLAUBBIT:()=>c}').entries(),
    ];
    for (const [name, category] of admitted)
      expect(isPublishableBinaryEnv(name, category)).toBe(true);
    expect(admitted.map(([n]) => n)).toEqual(['EMBEDDED_SEARCH_TOOLS']);
    // ...and the wider predicate genuinely is wider, or this test proves nothing.
    expect(isPublishableBinaryEnv('CLAUBBIT', 'other')).toBe(true);
    expect(isAccessorEvidenceEnv('CLAUBBIT', 'other')).toBe(false);
  });

  it('gates out non-first-party getters (constants + provider vars)', () => {
    // the real accessor map also holds ALL-CAPS constants and provider vars;
    // the claude-code gate must exclude every one of them.
    // None of these are on an audited list, so widening the gate must not admit
    // them: the map is ~43% non-env constants.
    const env = acc('{NEVER:()=>0,BROWSER_TOOLS:()=>t,NODE_OPTIONS:()=>o,AWS_REGION:()=>r}');
    expect(env.size).toBe(0);
  });

  it('still applies the denylist', () => {
    expect(acc('{JSON:()=>0,CLAUDE_REAL:()=>1}').has('JSON')).toBe(false);
  });

  it('anchors to object-key position, not mid-identifier', () => {
    expect(acc('{a:1,CLAUDE_CODE_X:()=>1}').has('CLAUDE_CODE_X')).toBe(true);
    expect(acc('{myCLAUDE_CODE_Y:()=>1}').has('CLAUDE_CODE_Y')).toBe(false);
  });

  it('tags accessor-map-only vars in the bundle; a direct read wins and is not duplicated', () => {
    const src =
      'process.env.CLAUDE_CODE_READ;let E={CLAUDE_CODE_READ:()=>1,CLAUDE_CODE_GETTER_ONLY:()=>2};';
    const syms = extractBundleSymbols(src);
    expect(syms.find((x) => x.symbol === 'CLAUDE_CODE_READ')?.evidence).toBe('process-env');
    expect(syms.find((x) => x.symbol === 'CLAUDE_CODE_GETTER_ONLY')?.evidence).toBe('accessor-map');
    expect(syms.filter((x) => x.symbol === 'CLAUDE_CODE_READ')).toHaveLength(1);
  });

  it('admits nothing from a map that holds no proven name', () => {
    // A module export map (`Tr(x,{…})`) has the env map's shape; its keys are constants.
    const src =
      'Tr(a,{CLAUDE_AI_OAUTH_SCOPES:()=>x,CLAUDE_AI_INFERENCE_SCOPE:()=>y});' +
      'Tr(b,{CLAUDE_CODE_USE_BEDROCK:()=>z,CLAUDE_CODE_NEW_TOGGLE:()=>w});';
    const env = extractAccessorEnvVars(src, new Set(['CLAUDE_CODE_USE_BEDROCK']));
    expect([...env.keys()]).toEqual(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_NEW_TOGGLE']);
  });

  it('reads the map a key sits in, not a neighbouring or nested one', () => {
    const src = '{CLAUDE_PROVEN:()=>a,inner:{CLAUDE_NESTED:()=>b}};{CLAUDE_ALONE:()=>c}';
    expect([...extractAccessorEnvVars(src, new Set(['CLAUDE_PROVEN'])).keys()]).toEqual([
      'CLAUDE_PROVEN',
    ]);
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

  it('marks a flag only an args-array predicate proves as predicateOnly', () => {
    // The same shape checks a shell command's arguments, not Claude Code's own argv:
    // the `/plugin list` filter and the `rm` delete check from the bundle.
    const src =
      'let n=t.slice(1).find((o)=>o==="--enabled"||o==="--disabled");' +
      'let y=s.some((v)=>v==="--recursive"||/^-[a-zA-Z]*[rR]/.test(v));';
    const only = new Set<string>();
    const flags = extractFlags(src, undefined, only);
    expect(flags.get('--enabled')).toBe('argv');
    expect([...only].sort()).toEqual(['--disabled', '--enabled', '--recursive']);
  });

  it('keeps the predicate label first, and any other proof clears the mark', () => {
    // `--bg` is checked by a predicate first and registered with commander later;
    // `--help` is checked by a predicate and dispatched by a switch. The first
    // occurrence sets the label, as before, and neither flag is predicateOnly.
    // Separate sources: the look-back window would otherwise reach across them.
    const read = (src: string) => {
      const only = new Set<string>();
      return { flags: extractFlags(src, undefined, only), only };
    };
    const bg = read('let c=t.find((m)=>m==="--bg");.option("--bg","run in the background");');
    expect(bg.flags.get('--bg')).toBe('argv');
    expect([...bg.only]).toEqual([]);
    const help = read('if(a.some((o)=>o==="--help"))h();switch(x){case"--help":break}');
    expect(help.flags.get('--help')).toBe('argv');
    expect([...help.only]).toEqual([]);
  });

  it('carries the predicateOnly mark into the cache record', () => {
    const syms = extractBundleSymbols('let y=s.some((v)=>v==="--recursive");.option("--print")');
    expect(syms.find((x) => x.symbol === '--recursive')).toMatchObject({ predicateOnly: true });
    expect(syms.find((x) => x.symbol === '--print')).not.toHaveProperty('predicateOnly');
  });

  it('reads argv evidence only inside the JavaScript chunks', () => {
    // A compiled release also embeds a skill's helper script, outside every chunk.
    const code = 'if(process.argv.includes("--print"))x();';
    const script = "const f = process.argv.includes('--seq-floor')";
    const src = `${code}\n${script}`;
    expect([...extractFlags(src).keys()].sort()).toEqual(['--print', '--seq-floor']);
    expect([...extractFlags(src, [code]).keys()]).toEqual(['--print']);
    expect(() => extractFlags(src, ['not in the text'])).toThrow(/not a slice/);
  });

  it('does not treat a foreign flag array/regex literal as own-evidence', () => {
    // formatter-detection regex from the bundle: a bare array of third-party tool
    // flags with no membership call or `===` comparison — must be ignored.
    const src = 'Cef=new RegExp(["--write","--fix","--in-place","--auto-correct"]);';
    const flags = extractFlags(src);
    expect(flags.has('--fix')).toBe(false);
    expect(flags.has('--write')).toBe(false);
    expect(flags.has('--in-place')).toBe(false);
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
    const src =
      'await w1(D7(),["rev-parse","--abbrev-ref","--symbolic-full-name"]);' +
      'let $={chrome:"--incognito",brave:"--incognito",firefox:"--private-window"};';
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

  it('keeps a flag built by a shared Option factory with no .addOption in the look-back', () => {
    // The real 2.1.83 → 2.1.84 refactor: 11 per-subcommand
    // `.addOption(new i4("--cowork",…))` sites collapsed into one factory. Zero sites
    // then had `.option`/`.addOption` in the window, so the lane reported --cowork
    // REMOVED at 2.1.84 when it was still registered through 2.1.112+.
    const src =
      'let w=()=>new G5("--cowork","Use cowork_plugins directory").hideHelp(),$=q.command("plugin");';
    expect(extractFlags(src).get('--cowork')).toBe('registration');
  });

  it('does not treat an Error whose message starts with a flag name as a registration', () => {
    // Real 2.1.224 shapes. A look-back that only requires `new X("--` admits these,
    // which published --configure-git and --messaging-socket-path as registered
    // flags on the strength of an error string. The spec must be a spec end to end.
    const src =
      'throw new lr(`--configure-git: could not restore hook stubs under ${n}`,"--configure-git: could not restore git hook stubs");' +
      'throw new Ie("--messaging-socket-path points to a live socket: "+p);';
    const flags = extractFlags(src);
    expect(flags.has('--configure-git')).toBe(false);
    expect(flags.has('--messaging-socket-path')).toBe(false);
  });

  it('records nothing for a short-only constructor spec (no long flag to key on)', () => {
    // `-v` is a valid spec but declares no long flag; the lane's grammar is
    // long-flag-only, so the spec is accepted and contributes zero symbols.
    expect(extractFlags('new Q("-v","Verbose output")').size).toBe(0);
  });

  it('rejects only the out-of-grammar alias in a constructor spec, keeping the rest', () => {
    // The real --allowedTools spec shape, reached through a constructor instead of
    // `.option(` — the camelCase token must be dropped without taking the lowercase
    // alias with it.
    const src = 'new Q("--allowedTools, --allowed-tools <tools...>","Tools to allow")';
    const flags = extractFlags(src);
    expect(flags.has('--allowedTools')).toBe(false);
    expect(flags.has('--allowed')).toBe(false);
    expect(flags.get('--allowed-tools')).toBe('registration');
  });

  it('accepts a whitespace-separated alias spec (commander allows it without a comma)', () => {
    const flags = extractFlags('new Q("-d --debug [filter]","Enable debug mode")');
    expect(flags.get('--debug')).toBe('registration');
  });

  it('reads an aliased spec and an arg placeholder from an Option constructor', () => {
    const src =
      'new Q("-c, --continue <id>","Continue a conversation");new Q("--bg, --background","Run in background")';
    const flags = extractFlags(src);
    expect(flags.get('--continue')).toBe('registration');
    expect(flags.get('--bg')).toBe('registration');
    expect(flags.get('--background')).toBe('registration');
  });

  it('rejects a camelCase flag whole instead of truncating it to a phantom', () => {
    // The real global spec. A bare /--[a-z][a-z0-9-]+/ scan stops at the capital `T`
    // and emits `--allowed`, which shipped from 0.2.33 with --allowedTools's own
    // description attached. The camelCase token is out of the lane's grammar; the
    // bracketed lowercase alias is in it.
    const src =
      '.option("--allowedTools, [--allowed-tools] <tools...>","Comma or space-separated list")';
    const flags = extractFlags(src);
    expect(flags.has('--allowed')).toBe(false);
    expect(flags.has('--allowedTools')).toBe(false);
    expect(flags.get('--allowed-tools')).toBe('registration');
  });

  it('includes flags dispatched by a hand-rolled switch over argv', () => {
    // The exact 2.1.224 `self-hosted-runner` parser shape. This subcommand is
    // argv-dispatched (`if(t[0]==="self-hosted-runner")`) and hidden from --help, so
    // no other evidence path reaches its ~28 flags.
    const src =
      'switch(n){case"--health-port":if(i){let s=Ld(i)}break;case"--drain-grace-sec":t.drainGraceSec=s;break;}';
    const flags = extractFlags(src);
    expect(flags.get('--health-port')).toBe('argv-switch');
    expect(flags.get('--drain-grace-sec')).toBe('argv-switch');
  });

  it('reads every label of a fall-through case group, ignoring short flags', () => {
    const flags = extractFlags('switch(n){case"--help":case"-h":t.help=!0;break;}');
    expect(flags.get('--help')).toBe('argv-switch');
    expect(flags.has('-h')).toBe(false);
  });

  it('lets a registration outrank a switch-case label for the same flag', () => {
    // The switch pass is additive — it must never downgrade stronger evidence.
    const src = '.option("--verbose","Show full output");switch(n){case"--verbose":t.v=!0;break;}';
    expect(extractFlags(src).get('--verbose')).toBe('registration');
  });

  it('rejects a camelCase case label whole rather than truncating it', () => {
    expect(extractFlags('switch(n){case"--dryRun":t.d=!0;break;}').size).toBe(0);
  });

  it('does not admit a subprocess flag that is merely passed, never switched on', () => {
    // `git commit --no-verify` — forwarded in an args array. You cannot switch on a
    // string you are only forwarding, which is what makes the case label sound.
    const src = 'switch(n){case"--log-level":t.l=i;break;}await w1(g,["commit","--no-verify"]);';
    const flags = extractFlags(src);
    expect(flags.get('--log-level')).toBe('argv-switch');
    expect(flags.has('--no-verify')).toBe(false);
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

  it('keeps the command but drops a template-literal (${VAR}) description', () => {
    // `Submit feedback about ${K4}` — the minified var churns every release.
    const cmds = extractCommands(
      '{type:"local",name:"bug",description:`Submit feedback about ${K4}`}'
    );
    expect(cmds.has('/bug')).toBe(true);
    expect(cmds.get('/bug')).toBeUndefined();
  });

  it('does not truncate a description containing an apostrophe (delimiter-aware)', () => {
    const cmds = extractCommands('{type:"local",name:"foo",description:"Don\'t stop here"}');
    expect(cmds.get('/foo')).toBe("Don't stop here");
  });

  it('skips a type marker with no resolvable command name', () => {
    expect(extractCommands('{type:"local",foo:"bar"}').size).toBe(0);
  });

  it('does not fork a namespaced command name with a colon', () => {
    // grammar matches the other lanes ([a-z0-9-]); a `ns:cmd` name is skipped,
    // not truncated to `/ns` or emitted as a divergent `/ns:cmd`.
    expect(extractCommands('{type:"local",name:"model:switch"}').size).toBe(0);
  });

  it('reads a "type-last" object where name/description precede the type marker', () => {
    // real minified shape (/vim): fields first, `type:` last.
    const src =
      '{name:"vim",description:"Toggle between Vim and Normal editing modes",isEnabled:()=>!0,type:"local"}';
    expect(extractCommands(src).get('/vim')).toBe('Toggle between Vim and Normal editing modes');
  });

  it('reads a type-last object with description before the name', () => {
    // /rewind shape: {description:…,name:…,aliases:[…],type:"local"}
    const src =
      '{description:"Restore to a previous point",name:"rewind",aliases:["undo"],type:"local"}';
    expect(extractCommands(src).get('/rewind')).toBe('Restore to a previous point');
  });

  it('does not bleed a neighbour’s fields into a type-last object', () => {
    const src =
      '{type:"local",name:"first",description:"one"},{name:"second",description:"two",type:"local"}';
    const cmds = extractCommands(src);
    expect(cmds.get('/first')).toBe('one');
    expect(cmds.get('/second')).toBe('two');
    expect(cmds.size).toBe(2);
  });

  it('does not truncate the forward window at a block-body field before name', () => {
    // a brace-bodied field before `name:` must not cut the object early (the
    // depth-aware close skips the inner `}`).
    const src = '{type:"local",isEnabled:()=>{return active},name:"cmd",description:"d"}';
    expect(extractCommands(src).get('/cmd')).toBe('d');
  });

  it('handles a type-last object with a block-body field before the marker', () => {
    const src = '{name:"vim",isEnabled:()=>{return on},description:"toggle",type:"local"}';
    expect(extractCommands(src).get('/vim')).toBe('toggle');
  });

  it('recovers a type-last command whose long get-description() getter pushes name past the back-window', () => {
    // real /sandbox shape: a computed `get description(){…}` (~480 chars) sits
    // between `name:` and a trailing `type:"local-jsx"`, putting `name:` ~520
    // chars back — beyond the old COMMAND_BACK=300 that silently dropped it.
    const getter =
      'get description(){let s="sandbox";' + 'if(cond)s+=" enabled";'.repeat(20) + 'return s}';
    const src = `{name:"sandbox",${getter},argumentHint:'exclude',immediate:!0,type:"local-jsx",load:()=>y}`;
    const cmds = extractCommands(src);
    expect(cmds.has('/sandbox')).toBe(true);
    expect(cmds.get('/sandbox')).toBeUndefined(); // computed getter → no static description
  });

  it('keeps a forward description for a "type-middle" object (name before, description after)', () => {
    // {name:…,type:…,description:…}: name precedes the marker (→ backward scan),
    // but the description follows it (→ forward window); the backward branch must
    // not clobber the forward description with undefined.
    const src = '{name:"mid",type:"local",description:"middle desc"}';
    expect(extractCommands(src).get('/mid')).toBe('middle desc');
  });

  it('lets a later definition backfill a missing description', () => {
    // two definitions of /dup, far enough apart that neither window reaches the
    // other's fields: the first has no description, the second supplies one.
    const src =
      '{type:"local",name:"dup"}' +
      'x'.repeat(600) +
      '{type:"local",name:"dup",description:"filled in"}';
    expect(extractCommands(src).get('/dup')).toBe('filled in');
  });

  it('keeps the FIRST description when a later duplicate carries a different one', () => {
    // first definition wins; the backfill path only fills a hole, never rewrites.
    const src =
      '{type:"local",name:"dup",description:"original"}' +
      'x'.repeat(600) +
      '{type:"local",name:"dup",description:"revised"}';
    const cmds = extractCommands(src);
    expect(cmds.get('/dup')).toBe('original');
    expect(cmds.size).toBe(1);
  });

  it('leaves a duplicate command undescribed when neither definition has a description', () => {
    const src = '{type:"local",name:"dup"}' + 'x'.repeat(600) + '{type:"local",name:"dup"}';
    const cmds = extractCommands(src);
    expect(cmds.has('/dup')).toBe(true);
    expect(cmds.get('/dup')).toBeUndefined();
    expect(cmds.size).toBe(1);
  });

  it('still reads an object whose closing brace is missing (truncated tail)', () => {
    // No `}` within the forward cap: the window falls back to the cap instead of
    // scanning to the end of the bundle, and the fields already seen are kept.
    expect(extractCommands('{type:"local",name:"cut",description:"d"').get('/cut')).toBe('d');
  });

  it('still reads a type-last object with no opening brace before it', () => {
    // No `{` within the back window: the backward scan bottoms out at its floor
    // rather than failing, and the preceding fields are still read.
    expect(extractCommands('name:"pre",description:"d",type:"local"}').get('/pre')).toBe('d');
  });
});

describe('extractSkillCommands — skill/menu registry', () => {
  it('reads a menuDescription command and restores the slash', () => {
    // real minified shape: FACTORY({name:"x",menuDescription:"…",aliases:[…]})
    const src =
      'Fc({name:"loop",menuDescription:"Repeat a prompt or command on an interval",aliases:["proactive"]})';
    expect(extractSkillCommands(src).get('/loop')).toBe(
      'Repeat a prompt or command on an interval'
    );
  });

  it('reads a whenToUse skill via its get-description accessor', () => {
    const src =
      'H2({name:"dream",get description(){return"Dream up ideas"},whenToUse:"when the user asks"})';
    expect(extractSkillCommands(src).get('/dream')).toBe('Dream up ideas');
  });

  it('reads a plain description when there is no menuDescription', () => {
    const src =
      'wCt({name:"schedule",aliases:["routines"],description:"Create and manage scheduled agents",whenToUse:"x"})';
    expect(extractSkillCommands(src).get('/schedule')).toBe('Create and manage scheduled agents');
  });

  it('prefers the menuDescription string over a plain description', () => {
    const src =
      'Fc({name:"design",menuDescription:"menu string",description:"long form",whenToUse:"x"})';
    expect(extractSkillCommands(src).get('/design')).toBe('menu string');
  });

  it('lets a later definition backfill a missing description', () => {
    // two /loop registrations far apart: the first carries only whenToUse (no
    // readable description), the second supplies the menu string.
    const src =
      'H2({name:"loop",whenToUse:"x"})' +
      'y'.repeat(600) +
      'Fc({name:"loop",menuDescription:"Repeat on an interval"})';
    expect(extractSkillCommands(src).get('/loop')).toBe('Repeat on an interval');
  });

  it('does NOT treat a highlight.js language grammar as a command (aliases is not a marker)', () => {
    // the crmsh false positive: name + aliases but no menuDescription/whenToUse.
    const src =
      'return{name:"crmsh",aliases:["crm","pcmk"],case_insensitive:!0,keywords:{keyword:"node primitive"}}';
    expect(extractSkillCommands(src).has('/crmsh')).toBe(false);
    expect(extractSkillCommands(src).size).toBe(0);
  });

  it('does not let an adjacent object’s marker bleed across the window', () => {
    // a bare `name:` grammar object, far from the only marker, must not be caught.
    const src = '{name:"grammar"}' + 'x'.repeat(500) + 'Fc({name:"real",menuDescription:"m"})';
    const cmds = extractSkillCommands(src);
    expect(cmds.has('/grammar')).toBe(false);
    expect(cmds.get('/real')).toBe('m');
  });

  it('skips a namespaced name with a colon (grammar parity with the other lanes)', () => {
    expect(extractSkillCommands('Fc({name:"ns:cmd",menuDescription:"m"})').size).toBe(0);
  });

  it('keeps the FIRST description when a later duplicate carries a different one', () => {
    const src =
      'Fc({name:"loop",menuDescription:"original"})' +
      'y'.repeat(600) +
      'Fc({name:"loop",menuDescription:"revised"})';
    const cmds = extractSkillCommands(src);
    expect(cmds.get('/loop')).toBe('original');
    expect(cmds.size).toBe(1);
  });

  it('leaves a duplicate skill undescribed when neither definition has a description', () => {
    const src =
      'H2({name:"loop",whenToUse:"x"})' + 'y'.repeat(600) + 'H2({name:"loop",whenToUse:"x"})';
    const cmds = extractSkillCommands(src);
    expect(cmds.has('/loop')).toBe(true);
    expect(cmds.get('/loop')).toBeUndefined();
    expect(cmds.size).toBe(1);
  });
});

describe('extractBundleSymbols — settings keys', () => {
  it('emits settings keys as config symbols carrying the schema description', () => {
    const src =
      '.option("--verbose","v");' +
      'Q=v.object({apiKeyHelper:v.string().describe("Path to an auth script"),' +
      'skipWorkflowUsageWarning:v.boolean().describe("@internal Accepted the warning")})';
    const out = extractBundleSymbols(src);
    expect(out.find((s) => s.symbol === 'apiKeyHelper')).toMatchObject({
      type: 'config_key',
      category: 'settings',
      evidence: 'settings-schema',
      description: 'Path to an auth script',
    });
    // An @internal key is plumbing, marked by CATEGORY. Typing off it would make
    // the record's identity churn every time Anthropic edits a description.
    expect(out.find((s) => s.symbol === 'skipWorkflowUsageWarning')).toMatchObject({
      type: 'config_key',
      category: 'settings-internal',
    });
  });

  it('omits the description field for a settings key the schema leaves undescribed', () => {
    const src = 'Q=v.object({apiKeyHelper:v.string()})';
    const key = extractBundleSymbols(src).find((s) => s.symbol === 'apiKeyHelper');
    expect(key).toMatchObject({ type: 'config_key', evidence: 'settings-schema' });
    expect(key?.description).toBeUndefined();
  });

  it('fails the whole extraction when the schema is present but unwalkable', () => {
    // Never return a partial set: downstream it is indistinguishable from the
    // missing keys having been deleted upstream.
    const src = 'Q=v.object({apiKeyHelper:v.string(),permissions:zWl(e)})';
    expect(() => extractBundleSymbols(src)).toThrow(/no resolvable definition/);
  });

  it('extracts normally from a bundle with no settings schema', () => {
    const out = extractBundleSymbols('.option("--verbose","v")');
    expect(out.some((s) => s.type === 'config_key')).toBe(false);
    expect(out.find((s) => s.symbol === '--verbose')?.type).toBe('cli_flag');
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
      {
        symbol: '--verbose',
        type: 'cli_flag',
        category: 'cli',
        evidence: 'registration',
        description: 'v',
      },
      {
        symbol: '/bug',
        type: 'command',
        category: 'command',
        evidence: 'command-registry',
        description: 'file a bug',
      },
      {
        symbol: 'CLAUDE_CODE_X',
        type: 'env_var',
        category: 'claude-code',
        evidence: 'process-env',
      },
    ]);
  });

  it('omits the description field for a command that has none', () => {
    const out = extractBundleSymbols('{type:"local",name:"status"}');
    expect(out).toEqual([
      { symbol: '/status', type: 'command', category: 'command', evidence: 'command-registry' },
    ]);
  });

  it('emits a typed-registry env var, letting a direct process.env read outrank it', () => {
    // CLAUDE_CODE_A is both read inline and declared in the registry: the read
    // wins and the symbol is not duplicated. CLAUDE_CODE_B is registry-only and
    // carries the declared type as observed evidence.
    const src =
      '$e={str:()=>a(),bool:()=>b(),int:()=>c()};olg=$e.bool(),nxt=$e.str();' +
      'X={CLAUDE_CODE_A:()=>olg,CLAUDE_CODE_B:()=>nxt};process.env.CLAUDE_CODE_A;';
    const syms = extractBundleSymbols(src);
    expect(syms.filter((s) => s.symbol === 'CLAUDE_CODE_A')).toHaveLength(1);
    expect(syms.find((s) => s.symbol === 'CLAUDE_CODE_A')?.evidence).toBe('process-env');
    expect(syms.find((s) => s.symbol === 'CLAUDE_CODE_B')).toMatchObject({
      type: 'env_var',
      category: 'claude-code',
      evidence: 'env-registry',
      declaredType: 'str',
    });
  });

  it('attaches scopes to a switch-case flag whose parser module prints one banner', () => {
    const src =
      'var A5h={};ut(A5h,{main:()=>x});' +
      'console.log(`Usage: claude self-hosted-runner [options]`);' +
      'switch(n){case"--capacity":t.c=i;break;}';
    const sym = extractBundleSymbols(src).find((s) => s.symbol === '--capacity');
    expect(sym).toMatchObject({
      type: 'cli_flag',
      evidence: 'argv-switch',
      scopes: ['self-hosted-runner'],
    });
    expect(sym?.description).toBeUndefined();
  });

  it('lets a complete switch scope win over a predicate label', () => {
    // The runner compares the flag in its own argv and dispatches it by `case`.
    const runner =
      'var A5h={};ut(A5h,{main:()=>x});' +
      'console.log(`Usage: claude self-hosted-runner [options]`);' +
      'if(a.some((o)=>o==="--proxy-x"))p();switch(n){case"--proxy-x":t.c=i;break;}';
    expect(extractBundleSymbols(runner).find((s) => s.symbol === '--proxy-x')).toMatchObject({
      evidence: 'argv-switch',
      scopes: ['self-hosted-runner'],
    });
    // A top-level argv check later in the bundle is proof the scope cannot override.
    const both = `${runner}if(process.argv.includes("--proxy-x"))q();`;
    expect(extractBundleSymbols(both).find((s) => s.symbol === '--proxy-x')).toMatchObject({
      evidence: 'argv',
    });
    // A scope left incomplete by a banner-less parser keeps the predicate's label.
    const help = `${runner}var B={};ut(B,{z:()=>y});switch(m){case"--proxy-x":break}`;
    const sym = extractBundleSymbols(help).find((s) => s.symbol === '--proxy-x');
    expect(sym).toMatchObject({ evidence: 'argv' });
    expect(sym).not.toHaveProperty('scopes');
  });

  it('adds a skill-registry command the built-in registry misses', () => {
    const out = extractBundleSymbols(
      'Fc({name:"claude-in-chrome",menuDescription:"Let Claude use Chrome"})'
    );
    expect(out).toEqual([
      {
        symbol: '/claude-in-chrome',
        type: 'command',
        category: 'command',
        evidence: 'skill-registry',
        description: 'Let Claude use Chrome',
      },
    ]);
  });

  it('omits the description field for a skill-registry command that has none', () => {
    const out = extractBundleSymbols('Fc({name:"bare",whenToUse:"x"})');
    expect(out).toEqual([
      { symbol: '/bare', type: 'command', category: 'command', evidence: 'skill-registry' },
    ]);
  });

  it('does not duplicate a command registered in BOTH registries (built-in wins)', () => {
    const src =
      '{type:"local",name:"loop",description:"builtin"}' +
      'x'.repeat(600) +
      'Fc({name:"loop",menuDescription:"menu"})';
    const loops = extractBundleSymbols(src).filter((s) => s.symbol === '/loop');
    expect(loops).toHaveLength(1);
    expect(loops[0]?.evidence).toBe('command-registry');
    expect(loops[0]?.description).toBe('builtin');
  });

  it('backfills a missing built-in description from the skill registry (no duplicate)', () => {
    const src =
      '{type:"local",name:"loop"}' + 'x'.repeat(600) + 'Fc({name:"loop",menuDescription:"menu"})';
    const loops = extractBundleSymbols(src).filter((s) => s.symbol === '/loop');
    expect(loops).toHaveLength(1);
    expect(loops[0]?.evidence).toBe('command-registry');
    expect(loops[0]?.description).toBe('menu');
  });
});

describe('extractHiddenFlags', () => {
  it('finds an Option chained to .hideHelp()', () => {
    const src = 'x.addOption(new sd("--agent-id <id>","Teammate agent ID").hideHelp())';
    expect([...extractHiddenFlags(src)]).toEqual(['--agent-id']);
  });

  it('ignores an Option with no .hideHelp()', () => {
    const src = 'x.addOption(new sd("--print","Print response and exit"))';
    expect(extractHiddenFlags(src).size).toBe(0);
  });

  it("does not attribute a later option's hideHelp to an earlier one", () => {
    // The scan may cross further chained calls on the SAME Option but never
    // another `new X(`, or every public flag preceding a hidden one would be
    // marked internal.
    const src =
      'x.addOption(new sd("--print","Print and exit")),' +
      'x.addOption(new sd("--agent-id <id>","Teammate agent ID").hideHelp())';
    expect([...extractHiddenFlags(src)]).toEqual(['--agent-id']);
  });

  it('still matches across other chained calls on the same Option', () => {
    const src =
      'x.addOption(new sd("--workload <tag>","Workload tag").argParser(f).default("x").hideHelp())';
    expect([...extractHiddenFlags(src)]).toEqual(['--workload']);
  });

  it('rejects a first argument that is not an option spec', () => {
    // `new lr("--configure-git: could not restore …")` is an Error message, the
    // same false positive OPTION_SPEC exists to stop.
    const src = 'throw new lr("--configure-git: could not restore hook stubs").hideHelp()';
    expect(extractHiddenFlags(src).size).toBe(0);
  });

  it('takes every long flag in an alias spec', () => {
    // One arg placeholder, at the end — the shape OPTION_SPEC accepts.
    const src = 'x.addOption(new sd("-w, --workload, --work-tag <tag>","Workload tag").hideHelp())';
    expect([...extractHiddenFlags(src)].sort()).toEqual(['--work-tag', '--workload']);
  });

  it('records nothing for a hidden short-only spec (no long flag to key on)', () => {
    // `-v` is a valid spec but declares no long flag; the lane's grammar is
    // long-flag-only, so the spec is accepted and contributes zero symbols.
    expect(extractHiddenFlags('x.addOption(new sd("-v","Verbose output").hideHelp())').size).toBe(
      0
    );
  });

  it('rejects a hidden camelCase flag whole rather than truncating it', () => {
    const src = 'x.addOption(new sd("--dryRun <x>","Dry run").hideHelp())';
    expect(extractHiddenFlags(src).size).toBe(0);
  });

  it('marks the flag on the extracted symbol', () => {
    const src = 'x.addOption(new sd("--agent-id <id>","Teammate agent ID").hideHelp())';
    const sym = extractBundleSymbols(src).find((s) => s.symbol === '--agent-id');
    expect(sym?.hidden).toBe(true);
  });

  it('leaves a public flag unmarked', () => {
    const src = 'x.addOption(new sd("--print","Print response and exit"))';
    expect(extractBundleSymbols(src).find((s) => s.symbol === '--print')?.hidden).toBeUndefined();
  });
});

describe('extractParamEnvVars — env vars read through a param bound to process.env', () => {
  const names = (src: string) => [...extractParamEnvVars(src).keys()].sort();

  it('extracts a read from a param a call passes process.env', () => {
    // function ndd(e){ e.CLAUDE_CODE_HTTP_PROXY } called ndd(process.env)
    const src =
      'function ndd(e){return e.HTTP_PROXY||e.CLAUDE_CODE_HTTP_PROXY}var x=ndd(process.env);';
    expect(names(src)).toEqual(['CLAUDE_CODE_HTTP_PROXY']);
  });

  it('accepts a {...process.env} spread argument', () => {
    const src = 'function f(e){return e.CLAUDE_CODE_ALTGR_AS_TEXT}f({...process.env,FOO:1});';
    expect(names(src)).toEqual(['CLAUDE_CODE_ALTGR_AS_TEXT']);
  });

  it('matches the argument POSITION to the parameter position', () => {
    // process.env is the SECOND arg, so only the second param is env-bound.
    const src =
      'function g(a,b){return a.CLAUDE_CODE_NOPE||b.CLAUDE_CODE_BS_AS_CTRL_BACKSPACE}g("linux",process.env);';
    expect(names(src)).toEqual(['CLAUDE_CODE_BS_AS_CTRL_BACKSPACE']);
  });

  it('skips a read through a nested scope that binds the same name again', () => {
    // Minified code reuses `e`: inside the arrow it is a list item, not process.env.
    const arrow =
      'function f(e){return e.CLAUDE_CODE_OUTER_READ||[{CLAUDE_CODE_ITEM:1}].map((e)=>e.CLAUDE_CODE_ITEM)}f(process.env);';
    expect(names(arrow)).toEqual(['CLAUDE_CODE_OUTER_READ']);
    const bare = 'function g(e){return[{}].map(e=>e.CLAUDE_CODE_BARE_ARROW)}g(process.env);';
    expect(names(bare)).toEqual([]);
    const nested =
      'function h(e){return function (e) {return e.CLAUDE_CODE_NESTED_FN}({})}h(process.env);';
    expect(names(nested)).toEqual([]);
    const caught = 'function k(e){try{x()}catch(e){return e.CLAUDE_CODE_CAUGHT}}k(process.env);';
    expect(names(caught)).toEqual([]);
  });

  it('resolves each read to its binding, not to a text span', () => {
    // An outer read after an expression-bodied arrow that rebinds the name.
    const after =
      'function f(e){[{}].map(e=>e.CLAUDE_CODE_ITEM);return e.CLAUDE_CODE_AFTER_ARROW}f(process.env);';
    expect(names(after)).toEqual(['CLAUDE_CODE_AFTER_ARROW']);
    // A property key in a destructured parameter binds `x`, not `e`.
    const key =
      'function g(e){return[{}].map(({e:x})=>{return e.CLAUDE_CODE_KEY_ONLY})}g(process.env);';
    expect(names(key)).toEqual(['CLAUDE_CODE_KEY_ONLY']);
    // A default value with a call still declares `e` in the arrow.
    const call =
      'function h(e){return[{}].map((e=mk())=>e.CLAUDE_CODE_DEFAULT_CALL)}h(process.env);';
    expect(names(call)).toEqual([]);
    // Text inside a string is not a read.
    const str = 'function k(e){return"e.CLAUDE_CODE_IN_STRING"}k(process.env);';
    expect(names(str)).toEqual([]);
    // An async helper keeps its `async`, so `await` parses and the check runs.
    const awaits =
      'async function a(e){await w();return[{}].map(e=>e.CLAUDE_CODE_ASYNC_ITEM)}a(process.env);';
    expect(names(awaits)).toEqual([]);
    // However `async` was spelled before it, the outer read is kept.
    const spaced =
      'async/*note*/function s(e){await w();return e.CLAUDE_CODE_ASYNC_OUTER}s(process.env);';
    expect(names(spaced)).toEqual(['CLAUDE_CODE_ASYNC_OUTER']);
    // A name from a default nested in a parameter is not the function's own parameter.
    const nestedDefault = 'function n(t=(n=process.env)=>1){return n.CLAUDE_CODE_FREE_NAME}';
    expect(names(nestedDefault)).toEqual([]);
    // Text that does not parse proves nothing, so no read is taken from it.
    const bad = 'function b(e){return e.CLAUDE_CODE_UNPARSED @}b(process.env);';
    expect(names(bad)).toEqual([]);
  });

  it.each([
    // [body of f(e), is the read the outer e?]
    ['return[].map((...e)=>e.CLAUDE_CODE_T)', false],
    ['return[].map(([e])=>e.CLAUDE_CODE_T)', false],
    ['return[].map(({...e})=>e.CLAUDE_CODE_T)', false],
    ['return function(){var e=1;return e.CLAUDE_CODE_T}', false],
    ['return function(){if(1){var e=1}return e.CLAUDE_CODE_T}', false],
    ['return function(){function e(){}return e.CLAUDE_CODE_T}', false],
    ['return function e(){return e.CLAUDE_CODE_T}', false],
    ['{let e=1;e.CLAUDE_CODE_T}', false],
    ['{const e=1;e.CLAUDE_CODE_T}', false],
    ['{class e{}e.CLAUDE_CODE_T}', false],
    ['for(let e of[])e.CLAUDE_CODE_T', false],
    ['for(const e in{})e.CLAUDE_CODE_T', false],
    ['for(let e=0;;)e.CLAUDE_CODE_T', false],
    ['class C{static{let e=1;e.CLAUDE_CODE_T}}', false],
    ['for(var e of[])e.CLAUDE_CODE_T', true],
    ['for(;;)e.CLAUDE_CODE_T', true],
    ['try{}catch{return e.CLAUDE_CODE_T}', true],
    ['return function(){var x=1;return e.CLAUDE_CODE_T}', true],
    ['return x[e.CLAUDE_CODE_T]', true],
    ['return{[e.CLAUDE_CODE_T]:1}', true],
    ['return{e:e.CLAUDE_CODE_T}', true],
    ['return function g(x=e.CLAUDE_CODE_T){var e;return x}', true],
    ['switch(1){case 1:let e={};return e.CLAUDE_CODE_T}', false],
    ['switch(1){case 1:function e(){}default:return e.CLAUDE_CODE_T}', false],
    ['switch(e.CLAUDE_CODE_T){case 1:let e=1}', true],
    ['switch(1){case 1:return e.CLAUDE_CODE_T}', true],
    ['return class e{static x=e.CLAUDE_CODE_T}', false],
    ['return class{static x=e.CLAUDE_CODE_T}', true],
    ['return function g(e=1){return e.CLAUDE_CODE_T}', false],
    ['return()=>{class C{static{var e=1}}return e.CLAUDE_CODE_T}', true],
    ['class C{static{var e=1;e.CLAUDE_CODE_T}}', false],
  ])('resolves %s to the outer parameter: %s', (body, outer) => {
    expect(names(`function f(e){${body}}f(process.env);`)).toEqual(outer ? ['CLAUDE_CODE_T'] : []);
  });

  it('keeps a read through a nested scope that binds other names', () => {
    // The real 2.1.306 proxy reader nests `E=(u,c)=>{…e[u]…}` and still reads e.
    const src =
      'function fWt(e){let n=e.CLAUDE_CODE_HTTP_PROXY,E=(u,c)=>{if(c&&e[u]===void 0)i[u]=c};return e.CLAUDE_CODE_HTTPS_PROXY}fWt(process.env);';
    expect(names(src)).toEqual(['CLAUDE_CODE_HTTPS_PROXY', 'CLAUDE_CODE_HTTP_PROXY']);
  });

  it('extracts from a destructure-default {env:n=process.env}, with no call site', () => {
    const src =
      'function h(t,{env:n=process.env}){return n.CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS}';
    expect(names(src)).toEqual(['CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS']);
  });

  it('does NOT extract a module-export assignment (not a process.env-bound param)', () => {
    // If.ANTHROPIC_API_HOST=… — `If` is an exports object, never passed process.env.
    const src = 'If.SEGMENT_CDN_HOST=If.ANTHROPIC_API_HOST=void 0;';
    expect(names(src)).toEqual([]);
  });

  it('does NOT extract an enum member reference (Model.CLAUDE_OPUS_4_8)', () => {
    const src = 'params.builder().model(Model.CLAUDE_OPUS_4_8);';
    expect(names(src)).toEqual([]);
  });

  it('does NOT extract a WRITE — CC setting an env var for a child process', () => {
    // param IS process.env, but `=` makes it a write, not a read.
    const src = 'function w(e){e.CLAUDE_CODE_PLUGIN_ROOT="x"}w(process.env);';
    expect(names(src)).toEqual([]);
  });

  it('does NOT extract a non-first-party name (fails the convention gate)', () => {
    const src = 'function k(e){return e.SOME_THIRD_PARTY_VAR}k(process.env);';
    expect(names(src)).toEqual([]);
  });

  it('does NOT extract when the function is never called with process.env', () => {
    const src = 'function m(e){return e.CLAUDE_CODE_MISS}m(somethingElse);';
    expect(names(src)).toEqual([]);
  });

  it('surfaces a param-passed env var through extractBundleSymbols as process-env evidence', () => {
    const src = 'function f(e){return e.CLAUDE_CODE_PROXY_TEST}f(process.env);';
    const sym = extractBundleSymbols(src).find((s) => s.symbol === 'CLAUDE_CODE_PROXY_TEST');
    expect(sym).toMatchObject({ type: 'env_var', evidence: 'process-env' });
  });

  it('does not crash on an unbalanced call (unmatched bracket)', () => {
    expect(names('f(process.env')).toEqual([]);
  });

  it('drops the call form when the callee name is defined more than once (ambiguous)', () => {
    // Two functions named `e`; a minified name reuse. One is called with
    // process.env, but the call cannot be bound to a specific definition, so
    // NEITHER is mined — no risk of stamping process.env onto the wrong param.
    const src = 'function e(x){return x.CLAUDE_CODE_AMBIG}function e(y){return y.z}e(process.env);';
    expect(names(src)).toEqual([]);
  });

  it('keeps the call form when a bundle embedded twice repeats the same definition', () => {
    // 2.1.113 to 2.1.132 embed the CLI bundle twice, so `MG1` is defined twice
    // with the same text. That is one function, and its read counts.
    const fn = 'function MG1(H,$){let q=$.CLAUDE_CODE_BS_AS_CTRL_BACKSPACE;return q}';
    const copy = `${fn}function Fe8(){return MG1("linux",process.env)}`;
    expect(names(copy + copy)).toEqual(['CLAUDE_CODE_BS_AS_CTRL_BACKSPACE']);
  });

  it('treats a definition whose extent cannot be matched as a different one', () => {
    const fn = 'function MG1(H,$){return $.CLAUDE_CODE_BS_AS_CTRL_BACKSPACE}';
    expect(names(`${fn}MG1("linux",process.env);function MG1(H,$`)).toEqual([]);
  });

  it('does not treat a trailing member read (process.env.HOME) as the env object', () => {
    // `process.env.HOME` is a scalar value, not the env object — `g` is not bound.
    const src = 'function g(a){return a.CLAUDE_CODE_TRAILING}g(process.env.HOME);';
    expect(names(src)).toEqual([]);
  });

  it('scans past an escaped quote inside a string argument', () => {
    // The `"a\"b"` string carries an escaped quote — bracket matching and the
    // top-level comma split must skip it, not end the string early.
    const src = 'function f(e){return e.CLAUDE_CODE_ESCAPE}f(process.env,"a\\"b");';
    expect(names(src)).toEqual(['CLAUDE_CODE_ESCAPE']);
  });

  it('does not crash on a call whose brackets are mismatched', () => {
    // `f(])` closes with the wrong bracket — matchBracket bails rather than
    // running off the end.
    expect(names('f(])')).toEqual([]);
  });

  it('skips a param this reader cannot name (a bare destructure) and binds the next', () => {
    // `{a}` yields no binding name; the env-bound `e` two positions over still does.
    const src = 'function f({a},e){return e.CLAUDE_CODE_DESTRUCT}f(0,process.env);';
    expect(names(src)).toEqual(['CLAUDE_CODE_DESTRUCT']);
  });

  it('binds every param position a repeated process.env argument fills', () => {
    // Both args are process.env, so the callee is recorded once and both params
    // are env-bound — the second read is still mined.
    const src = 'function f(a,b){return b.CLAUDE_CODE_TWICE}f(process.env,process.env);';
    expect(names(src)).toEqual(['CLAUDE_CODE_TWICE']);
  });

  it('does not crash on a definition whose parameter list never closes', () => {
    expect(names('function bad(')).toEqual([]);
  });

  it('ignores a function definition with no block body', () => {
    // Params match but no `{` follows — nothing to read.
    expect(names('function f(a)0')).toEqual([]);
  });

  it('does not crash on a definition whose body brace never closes', () => {
    expect(names('function f(e){return e.CLAUDE_CODE_UNCLOSED')).toEqual([]);
  });

  it('drops a denylisted name (a libuv errno code, not an env var)', () => {
    const src = 'function f(e){return e.ETIMEDOUT}f(process.env);';
    expect(names(src)).toEqual([]);
  });

  it('does not double-count a var the inline process.env path already proved', () => {
    // Same name read both inline and through the param — the additive pass must
    // skip it, leaving exactly one record.
    const src =
      'process.env.CLAUDE_CODE_DUP;function f(e){return e.CLAUDE_CODE_DUP}f(process.env);';
    const dups = extractBundleSymbols(src).filter((s) => s.symbol === 'CLAUDE_CODE_DUP');
    expect(dups).toHaveLength(1);
  });

  it('reads through a `$`-named param (a minifier name `\\b` would silently drop)', () => {
    // `$` is a valid identifier a minifier emits; the read anchor must not treat it
    // as a word boundary or a regex metachar. Both binding forms must work.
    expect(names('function f({env:$=process.env}){return $.CLAUDE_CODE_DOLLAR}')).toEqual([
      'CLAUDE_CODE_DOLLAR',
    ]);
    expect(names('function g($){return $.CLAUDE_CODE_DOLLAR2}g(process.env);')).toEqual([
      'CLAUDE_CODE_DOLLAR2',
    ]);
  });

  it('does not bind a param name that is only a suffix of the accessed identifier', () => {
    // `some$e.NAME` must not count as a read through param `e`. `$` is a word
    // boundary, so the old `\b` anchor matched this wrongly — the `(?<![\w$])`
    // lookbehind rejects it because `$` is an identifier char.
    const src = 'function k(e){return some$e.CLAUDE_CODE_NO}k(process.env);';
    expect(names(src)).toEqual([]);
  });
});

describe('extractNameReaderEnvVars — env vars read by name through a helper', () => {
  const names = (...chunks: string[]) => [...extractNameReaderEnvVars(chunks).keys()].sort();
  // The 2.1.301 shape: a numeric reader called with each variable's name.
  const ST = 'function St(e){let n=process.env[e];if(n===void 0||n==="")return 0;return Number(n)}';

  it('reads the literal passed to a helper that reads process.env[param]', () => {
    const src =
      ST + 'x={grace:St("SELF_HOSTED_RUNNER_SIGKILL_GRACE_MS")||30000,y:St(\'OTHER_NAME\',1)}';
    expect(names(src)).toEqual(['OTHER_NAME', 'SELF_HOSTED_RUNNER_SIGKILL_GRACE_MS']);
  });

  it('resolves the helper in its own chunk only', () => {
    // Another chunk reuses the name for an unrelated function.
    const other = 'function St(e){return e.map(String)}St("NOT_AN_ENV_VAR");';
    expect(names(ST + 'St("RUNNER_A")', other)).toEqual(['RUNNER_A']);
    expect(names(ST, 'St("NOT_READ_HERE")')).toEqual([]);
  });

  it('drops a name defined twice with different bodies in one chunk', () => {
    expect(names(ST + 'function St(e){return e}St("AMBIGUOUS_NAME")')).toEqual([]);
    // The same text twice is one function (a bundle embedded twice).
    expect(names(ST + ST + 'St("EMBEDDED_TWICE")')).toEqual(['EMBEDDED_TWICE']);
  });

  it('requires a read of the FIRST parameter, not a write or another parameter', () => {
    expect(names('function W(e,t){process.env[e]=t}W("WRITTEN_NAME","1")')).toEqual([]);
    expect(names('function U(e){delete process.env[e]}U("DELETED_NAME")')).toEqual([]);
  });

  it('requires a flat body, so a reused or rebound name cannot fake a read', () => {
    // The read is the arrow's own `e`, not the helper's parameter.
    expect(names('function f(e){return["HOME"].map(e=>process.env[e])}f("NESTED_ARROW")')).toEqual(
      []
    );
    expect(
      names('function g(e){return function(e){return process.env[e]}("HOME")}g("NESTED_FUNCTION")')
    ).toEqual([]);
    expect(names('function h(e){e="HOME";return process.env[e]}h("REASSIGNED")')).toEqual([]);
    expect(
      names('function k(e){for(const e of["HOME"])process.env[e];return 0}k("REDECLARED")')
    ).toEqual([]);
    expect(names('function S(t,e){return process.env[e]}S("SECOND_PARAM")')).toEqual([]);
    expect(names('function Z(){return process.env.HOME}Z("NO_PARAM")')).toEqual([]);
  });

  it('skips a denylisted name and a helper whose extent cannot be matched', () => {
    // An errno code is never an env var, whatever reads it.
    expect(names(ST + 'St("EACCES")')).toEqual([]);
    // An unbalanced body makes the definition unreadable, so it proves nothing.
    expect(names('function Q(e){let n=process.env[e];Q("UNBALANCED_NAME")')).toEqual([]);
  });

  it('adds the reads to a full extraction as process-env evidence', () => {
    const src = ST + 'process.env.DIRECT_READ;St("DIRECT_READ");St("HELPER_ONLY_READ")';
    const env = extractBundleSymbols(src, [src]).filter((sym) => sym.type === 'env_var');
    expect(env.map((sym) => [sym.symbol, sym.evidence])).toEqual([
      ['DIRECT_READ', 'process-env'],
      ['HELPER_ONLY_READ', 'process-env'],
    ]);
    // A name the parameter path already found is not added twice.
    const both =
      ST + 'function P(e){return e.CLAUDE_CODE_BOTH}P(process.env);St("CLAUDE_CODE_BOTH")';
    const found = extractBundleSymbols(both, [both]).filter(
      (sym) => sym.symbol === 'CLAUDE_CODE_BOTH'
    );
    expect(found).toHaveLength(1);
  });
});

describe('command aliases', () => {
  it('reads the aliases of a registry object, before or after its type marker', () => {
    // 2.1.312 shapes: `/config` lists `aliases` before `type`, `/resume` after it.
    const cmds = extractCommands(
      '{aliases:["settings"],type:"local-jsx",name:"config",description:"Open settings"},' +
        '{type:"local-jsx",name:"resume",get description(){return"Resume"},aliases:["continue"]}'
    );
    expect(cmds.has('/settings')).toBe(true);
    expect(cmds.has('/continue')).toBe(true);
    expect(cmds.get('/config')).toBe('Open settings');
  });

  it('gives an alias no description, since the text belongs to the command', () => {
    const cmds = extractCommands('{type:"local",name:"exit",description:"Exit",aliases:["quit"]}');
    expect(cmds.has('/quit')).toBe(true);
    expect(cmds.get('/quit')).toBeUndefined();
  });

  it('ignores an aliases list outside a command object', () => {
    // The 2.1.312 keybinding table and a bundled highlight.js grammar.
    const src =
      'en=[{name:"ctrl",aliases:["control"]},{name:"cmd",aliases:["command","super","win"]}];' +
      '{name:"crmsh",aliases:["crm","pcmk"],keywords:{}}';
    expect(extractCommands(src).size).toBe(0);
    expect(extractSkillCommands(src).size).toBe(0);
  });

  it('stops at the command object, so the aliases of a neighbour stay out', () => {
    // A command with no aliases of its own, then the keybinding table.
    const cmds = extractCommands('{type:"local",name:"exit"},{name:"cmd",aliases:["command"]}');
    expect(cmds.has('/exit')).toBe(true);
    expect(cmds.has('/command')).toBe(false);
  });

  it('keeps a registered command over an alias of the same name', () => {
    // 2.1.306: `/update` is a command's own name and also another's alias.
    const cmds = extractCommands(
      '{type:"local",name:"restart",aliases:["update"]},' +
        '{type:"local",name:"update",description:"Switch to the latest version"}'
    );
    expect(cmds.get('/update')).toBe('Switch to the latest version');
  });

  it('keeps a skill name over a skill alias of the same name', () => {
    const src =
      'ol({name:"loop",aliases:["schedule"],menuDescription:"Repeat"}),' +
      'ol({name:"schedule",menuDescription:"Create scheduled agents"})';
    expect(extractSkillCommands(src).get('/schedule')).toBe('Create scheduled agents');
  });

  it('reads skill aliases from the entry object only', () => {
    // A neighbour's list must stay out, and a list before `name:` still counts.
    const src =
      'ol({name:"doctor",menuDescription:"Health"}),{aliases:["control"],name:"ctrl"},' +
      'ol({aliases:["routines"],name:"schedule",menuDescription:"Schedule agents"})';
    const cmds = extractSkillCommands(src);
    expect(cmds.has('/control')).toBe(false);
    expect(cmds.has('/routines')).toBe(true);
  });

  it('reads the aliases of a skill registry entry', () => {
    const src = 'ol({name:"doctor",aliases:["checkup"],menuDescription:"Health-check your setup"})';
    const cmds = extractSkillCommands(src);
    expect(cmds.has('/checkup')).toBe(true);
    expect(cmds.get('/checkup')).toBeUndefined();
  });
});

describe('command alias evidence', () => {
  const evidenceOf = (src: string, symbol: string) =>
    extractBundleSymbols(src).find((s) => s.type === 'command' && s.symbol === symbol)?.evidence;

  it('tags an alias apart from a registered name', () => {
    const src = '{type:"local",name:"update",aliases:["restart"],description:"Update"}';
    expect(evidenceOf(src, '/update')).toBe('command-registry');
    expect(evidenceOf(src, '/restart')).toBe('command-alias');
  });

  it('takes a skill name as the evidence over a command-registry alias', () => {
    const src =
      '{type:"local",name:"exit",aliases:["quit"]},' +
      'ol({name:"quit",menuDescription:"Quit the session"})';
    expect(evidenceOf(src, '/quit')).toBe('skill-registry');
  });

  it('tags an alias found only in the skill registry', () => {
    const src = 'ol({name:"doctor",aliases:["checkup"],menuDescription:"Health"})';
    expect(evidenceOf(src, '/checkup')).toBe('command-alias');
  });
});

describe('extractParamEnvVars — function extents and shapes', () => {
  const read = (src: string) => extractParamEnvVars(src).has('CLAUDE_CODE_X');
  const tail = ';return e.CLAUDE_CODE_X}f(process.env);';

  it('reads past a regex literal that holds a quote or a bracket', () => {
    expect(read('function f(e){let t=/"/g' + tail)).toBe(true);
    expect(read('function f(e){let t=/[{]/' + tail)).toBe(true);
    expect(read('function f(e){let t=/\\(/' + tail)).toBe(true);
    expect(read(`function f(e){let t=x.replace(/^['"]|['"]$/g,"")` + tail)).toBe(true);
  });

  it('reads past a comment that holds a quote', () => {
    expect(read("function f(e){/* don't */return e.CLAUDE_CODE_X}f(process.env);")).toBe(true);
    expect(read("function f(e){// don't\nreturn e.CLAUDE_CODE_X}f(process.env);")).toBe(true);
  });

  it('ignores what a comment ends with when it reads the token before a slash', () => {
    // Each comment ends with a value-like character; the slash after it opens a regex.
    expect(read('function f(e){let t=// "\n/[{]/;return e.CLAUDE_CODE_X}f(process.env);')).toBe(
      true
    );
    expect(read('function f(e){let t=// i++\n/[{]/;return e.CLAUDE_CODE_X}f(process.env);')).toBe(
      true
    );
    expect(read('function f(e){let t=/* x) */ /[{]/;return e.CLAUDE_CODE_X}f(process.env);')).toBe(
      true
    );
  });

  it('reads a keyword after a dot as a property name, so the slash divides', () => {
    for (const body of [
      'var a=b.return/2',
      'var a=b?.in/2',
      'var a=b. typeof/2',
      'var a=b\n.case/2',
    ])
      expect(read(`function f(e){${body}` + tail), body).toBe(true);
  });

  it('keeps every read that the plain bracket scan finds', () => {
    // Each misleads the token-aware scan, so only the plain scan reads it; see
    // matchBracketLexed. They came from an adversarial probe against main.
    for (const body of [
      'if(b){}/[/]/.test(b)',
      'while(0)/\\//.test(b)',
      'var a=b./**/return/2',
      'class K{#return=1;m(){return this.#return/2}}',
      'var a=1./2',
      'var a=1..in/2',
    ])
      expect(read(`function f(e){${body}` + tail), body).toBe(true);
  });

  it('reads strings, postfix operators and bracket mismatches on the fallback scan', () => {
    // The `)` in `/[)]/` ends the plain scan, so each of these reaches the token-aware one.
    expect(read('function f(e){let t=/[)]/,u="a\\"b",v=i++/2' + tail)).toBe(true);
    expect(read('function f(e){let t=/[)]/;(]' + tail)).toBe(false);
  });

  it('falls back when the plain scan ends the parameter list early', () => {
    expect(read('function f(e=process.env,r=/\\)/){return e.CLAUDE_CODE_X}')).toBe(true);
  });

  it('falls back for two identical copies of a function', () => {
    const fn = 'function f(e){let r=/[)]/;return e.CLAUDE_CODE_X}';
    expect(read(`${fn}${fn}f(process.env);`)).toBe(true);
  });

  it('binds process.env only to the parameter at its position', () => {
    // The fallback finds this parameter list, but splitTopLevel miscounts the
    // regex's brackets and would number `t` as the second parameter. The same
    // miscount makes `function f(r=/[)]/,e){…}f(1,process.env)` a miss, as on main.
    expect(read('function f(r=/[)]/,s,t){return t.CLAUDE_CODE_X}f(1,process.env,2);')).toBe(false);
  });

  it('binds no argument of a call that only the lexed scan could bound', () => {
    // splitTopLevel would count the regex's brackets and give process.env index 0.
    expect(read('function f(r,e){return r.CLAUDE_CODE_X}f(/[)]/,process.env);')).toBe(false);
  });

  it('opens a regex after a keyword that follows a spread', () => {
    expect(
      read(
        'async function f(e){let t=[...await /[{]/.exec("{")];return e.CLAUDE_CODE_X}f(process.env);'
      )
    ).toBe(true);
    expect(
      read('function* f(e){let t=[...yield /[{]/];return e.CLAUDE_CODE_X}f(process.env);')
    ).toBe(true);
    expect(
      read('function f(e){let t={...typeof /[{]/};return e.CLAUDE_CODE_X}f(process.env);')
    ).toBe(true);
  });

  it('divides after `of`, a non-ASCII name, and opens a regex after instanceof', () => {
    expect(read('function f(e){var of=4,a=of/2' + tail)).toBe(true);
    expect(read('function f(e){var é=1,a=é/2' + tail)).toBe(true);
    expect(read('function f(e){var a=b instanceof/[)}]/' + tail)).toBe(true);
  });

  it('opens a regex after a keyword and divides after a regex', () => {
    expect(
      read('function f(e){if(x)return/[{]/.test(y);return e.CLAUDE_CODE_X}f(process.env);')
    ).toBe(true);
    expect(read('function f(e){let t=/a/g/2' + tail)).toBe(true);
  });

  it('finds no extent past an unclosed comment or a regex that runs into a newline', () => {
    expect(read('function f(e){/* never closed return e.CLAUDE_CODE_X}f(process.env);')).toBe(
      false
    );
    expect(read('function f(e){let t=x+ /a\nreturn e.CLAUDE_CODE_X}f(process.env);')).toBe(false);
  });

  it('still reads a division as a division', () => {
    expect(read('function f(e){let t=a/b/c' + tail)).toBe(true);
    expect(read('function f(e){let t=(a)/2/(b)' + tail)).toBe(true);
    expect(read('function f(e){let t="6"/2' + tail)).toBe(true);
    expect(read("function f(e){let t='6'/2" + tail)).toBe(true);
    expect(read('function f(e){let t=`6`/2' + tail)).toBe(true);
    expect(read('function f(e){let t=i++/2' + tail)).toBe(true);
    expect(read('function f(e){let t=i--/2' + tail)).toBe(true);
  });

  it('reads a generator function', () => {
    expect(read('function*f(e){yield e.CLAUDE_CODE_X}f(process.env);')).toBe(true);
    expect(read('function* f(e){yield e.CLAUDE_CODE_X}f(process.env);')).toBe(true);
    expect(read('async function*f(e){yield e.CLAUDE_CODE_X}f(process.env);')).toBe(true);
  });

  it("reads a later parameter's default", () => {
    expect(read('function f(e,t=e.CLAUDE_CODE_X){return t}f(process.env);')).toBe(true);
    expect(read('function f(n=process.env,t=n.CLAUDE_CODE_X){return t}')).toBe(true);
  });

  it('skips a default whose read goes through a rebound name', () => {
    expect(read('function f(e,t=(e)=>e.CLAUDE_CODE_X){return t}f(process.env);')).toBe(false);
  });
});

describe('textAbsent', () => {
  const src =
    'x=process.env.CLAUDE_CODE_FRAME_MODE;y("--foo-bar");z={name:"plan"};w=process.env.KEEP';

  it('reports a name only when no whole token in the text matches it', () => {
    expect(
      textAbsent(src, [
        { type: 'env_var', symbol: 'CLAUDE_CODE_FRAME' }, // only inside a longer name
        { type: 'env_var', symbol: 'CLAUDE_CODE_FRAME_MODE' },
        { type: 'env_var', symbol: 'KEEP' },
        { type: 'cli_flag', symbol: '--foo' }, // only the start of a longer flag
        { type: 'cli_flag', symbol: '--foo-bar' },
        { type: 'command', symbol: '/plan' },
        { type: 'command', symbol: '/gone' },
      ])
    ).toEqual(['cli_flag:--foo', 'command:/gone', 'env_var:CLAUDE_CODE_FRAME']);
  });

  it('never reports a name it cannot judge', () => {
    // A mixed-case variable and another type: no token shape covers them.
    expect(
      textAbsent(src, [
        { type: 'env_var', symbol: 'SystemDrive' },
        { type: 'config_key', symbol: 'model' },
      ])
    ).toEqual([]);
  });
});

describe('textAbsentFor', () => {
  it('checks only names first seen earlier that this release did not extract', () => {
    const watch = [
      { type: 'env_var', symbol: 'OLD_GONE', first_seen: '2.1.100' },
      { type: 'env_var', symbol: 'OLD_HERE', first_seen: '2.1.100' },
      { type: 'env_var', symbol: 'NEWER', first_seen: '2.1.300' },
      { type: 'env_var', symbol: 'SAME_RELEASE', first_seen: '2.1.200' },
    ];
    // OLD_HERE is extracted, NEWER is first seen later, SAME_RELEASE is not earlier.
    expect(
      textAbsentFor('nothing here', '2.1.200', [{ type: 'env_var', symbol: 'OLD_HERE' }], watch)
    ).toEqual(['env_var:OLD_GONE']);
  });
});

describe('withChildEnvVars', () => {
  const read = [
    { symbol: 'CLAUDE_READ', type: 'env_var', category: 'claude-code', evidence: 'process-env' },
    { symbol: '--CLAUDE_FLAG_ONLY', type: 'cli_flag', category: 'cli', evidence: 'argv' },
  ] as const;

  it('adds each new name as an env_var with child-env evidence, after the read symbols', () => {
    const out = withChildEnvVars(read, ['CLAUDE_RUNNER_EXIT_REASON', 'GIT_TERMINAL_PROMPT']);
    expect(out.slice(0, 2)).toEqual(read);
    expect(out.slice(2)).toEqual([
      {
        symbol: 'CLAUDE_RUNNER_EXIT_REASON',
        type: 'env_var',
        category: 'claude-code',
        evidence: 'child-env',
      },
      { symbol: 'GIT_TERMINAL_PROMPT', type: 'env_var', category: 'other', evidence: 'child-env' },
    ]);
  });

  it('keeps a read-proved name as it is and skips denylisted names', () => {
    const out = withChildEnvVars(read, ['CLAUDE_READ', 'EACCES']);
    expect(out).toEqual(read);
  });
});

describe('extractParamEnvVars — chunks of the code-split era', () => {
  const names = (chunks: string[]) =>
    [...extractParamEnvVars(chunks.join('\n'), chunks).keys()].sort();

  it('reads a function whose short name another chunk declares again', () => {
    // The flat bundle has two different `jE`s, so the name is ambiguous there.
    const own = 'function jE(n,u){return n.CLAUDE_CODE_ALTGR_AS_TEXT}jE(process.env,1);';
    const other = 'function jE(a){return a+1}jE(2);';
    expect([...extractParamEnvVars(`${own}\n${other}`).keys()]).toEqual([]);
    expect(names([own, other])).toEqual(['CLAUDE_CODE_ALTGR_AS_TEXT']);
  });

  it('carries a call to an imported function to the chunk that exports it', () => {
    const owner =
      'function i9t(e){return e.CLAUDE_CODE_HTTP_PROXY}function q(){}export{i9t,q as Q,};';
    const caller = 'import{i9t as P,Q,}from"/$bunfs/root/chunk-aa.js";P(process.env);Q();';
    const unrelated = 'function i9t(x){return x.CLAUDE_CODE_NOT_ENV}i9t(Xt);';
    expect(names([owner, caller, unrelated])).toEqual(['CLAUDE_CODE_HTTP_PROXY']);
  });

  it('transfers no call whose name could be another binding than the import', () => {
    // From review: `g` in `run` is a parameter, not the imported `f`.
    const owner = 'function f(e){return e.CLAUDE_CODE_TEST_PROXY}export{f};';
    const shadowed =
      'import{f as g}from"/$bunfs/root/chunk-dd.js";function run(g){g(process.env)}run(o);';
    expect(names([owner, shadowed])).toEqual([]);
    const declared =
      'import{f as g}from"/$bunfs/root/chunk-dd.js";function k(){function g(){}g(process.env)}';
    expect(names([owner, declared])).toEqual([]);
    const passed = 'import{f as g}from"/$bunfs/root/chunk-dd.js";g(process.env);h(g);';
    expect(names([owner, passed])).toEqual([]);
    const called = 'import{f as g}from"/$bunfs/root/chunk-dd.js";g(process.env);g(1);';
    expect(names([owner, called])).toEqual(['CLAUDE_CODE_TEST_PROXY']);
  });

  it('follows no import whose module two chunks could be', () => {
    const a = 'function f(e){return e.CLAUDE_CODE_FROM_A}export{f};';
    const b = 'function f(e){return e.CLAUDE_CODE_FROM_B}export{f};';
    const caller = 'import{f}from"/$bunfs/root/chunk-bb.js";f(process.env);';
    expect(names([a, b, caller])).toEqual([]);
  });

  it('skips a re-export facade and a call to a name that is not imported', () => {
    const owner = 'function f(e){return e.CLAUDE_CODE_FACADE}export{f};';
    const facade = 'export{f}from"/$bunfs/root/chunk-cc.js";';
    const caller = 'import{f as g}from"/$bunfs/root/chunk-cc.js";g(process.env);h(process.env);';
    expect(names([owner, facade, caller])).toEqual(['CLAUDE_CODE_FACADE']);
  });
});

describe('withVariableSkills', () => {
  const read = [
    { symbol: '/schedule', type: 'command', category: 'command', evidence: 'skill-registry' },
  ] as const;

  it('adds a new name and an alias, after the read symbols, and keeps a known command', () => {
    const out = withVariableSkills(read, [
      { symbol: '/loop', alias: false, description: 'Repeat a prompt' },
      { symbol: '/proactive', alias: true },
      { symbol: '/schedule', alias: false, description: 'ignored' },
    ]);
    expect(out).toEqual([
      ...read,
      {
        symbol: '/loop',
        type: 'command',
        category: 'command',
        evidence: 'skill-registry',
        description: 'Repeat a prompt',
      },
      { symbol: '/proactive', type: 'command', category: 'command', evidence: 'command-alias' },
    ]);
  });
});
