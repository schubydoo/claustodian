// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  extractAccessorEnvVars,
  extractBundleSymbols,
  extractCommands,
  extractEnvVars,
  extractFlagDescriptions,
  extractFlags,
  extractSkillCommands,
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
    const d = extractFlagDescriptions('.option("--verbose","Same text");.option("--verbose","Same text")', known);
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
  it('captures claude-code NAME:()=> getter entries', () => {
    const env = extractAccessorEnvVars('let E={CLAUDE_CODE_FOO:()=>x,ANTHROPIC_BAR:()=>y};');
    expect(env.get('CLAUDE_CODE_FOO')).toBe('claude-code');
    expect(env.get('ANTHROPIC_BAR')).toBe('claude-code');
  });

  it('gates out non-first-party getters (constants + provider vars)', () => {
    // the real accessor map also holds ALL-CAPS constants and provider vars;
    // the claude-code gate must exclude every one of them.
    const env = extractAccessorEnvVars('{NEVER:()=>0,BROWSER_TOOLS:()=>t,NODE_OPTIONS:()=>o,AWS_REGION:()=>r}');
    expect(env.size).toBe(0);
  });

  it('still applies the denylist', () => {
    expect(extractAccessorEnvVars('{JSON:()=>0,CLAUDE_REAL:()=>1}').has('JSON')).toBe(false);
  });

  it('anchors to object-key position, not mid-identifier', () => {
    expect(extractAccessorEnvVars('{a:1,CLAUDE_CODE_X:()=>1}').has('CLAUDE_CODE_X')).toBe(true);
    expect(extractAccessorEnvVars('{myCLAUDE_CODE_Y:()=>1}').has('CLAUDE_CODE_Y')).toBe(false);
  });

  it('tags accessor-map-only vars in the bundle; a direct read wins and is not duplicated', () => {
    const src =
      'process.env.CLAUDE_CODE_READ;let E={CLAUDE_CODE_READ:()=>1,CLAUDE_CODE_GETTER_ONLY:()=>2};';
    const syms = extractBundleSymbols(src);
    expect(syms.find((x) => x.symbol === 'CLAUDE_CODE_READ')?.evidence).toBe('process-env');
    expect(syms.find((x) => x.symbol === 'CLAUDE_CODE_GETTER_ONLY')?.evidence).toBe('accessor-map');
    expect(syms.filter((x) => x.symbol === 'CLAUDE_CODE_READ')).toHaveLength(1);
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

  it('includes flags checked via a .find/.some/.filter args predicate (incl. ||-chained)', () => {
    // the exact minified shape from the bundle for `claude mcp ls --enabled/--disabled`
    const src = 'let n=t.slice(1).find((o)=>o==="--enabled"||o==="--disabled");';
    const flags = extractFlags(src);
    expect(flags.get('--enabled')).toBe('argv');
    expect(flags.get('--disabled')).toBe('argv');
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
    const cmds = extractCommands('{type:"local",name:"bug",description:`Submit feedback about ${K4}`}');
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
      { symbol: '--verbose', type: 'cli_flag', category: 'cli', evidence: 'registration', description: 'v' },
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
