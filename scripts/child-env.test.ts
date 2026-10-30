import { describe, expect, it } from 'vitest';
import { collectChildEnvNames, ENV_FLOW_HOPS } from './child-env.js';
import { parse } from './control-lane.js';

const names = (src: string) => [...collectChildEnvNames(parse(src))].sort();

describe('collectChildEnvNames', () => {
  it('reads the keys of an object literal passed as `env`', () => {
    expect(names('spawn("x",[],{env:{...process.env,CLAUDE_RUNNER_ORDER_ID:o}})')).toEqual([
      'CLAUDE_RUNNER_ORDER_ID',
    ]);
  });

  it('follows a variable through a wrapper call into its declaration', () => {
    // The hook shape: the object is declared first and reaches `env` inside a call.
    const src =
      'async function h(e){let n={...ie(),CLAUDE_RUNNER_EXIT_REASON:e.r};' +
      'on(e.p,[],{env:an(e.pins?gEs(n):n,un(e))})}';
    expect(names(src)).toEqual(['CLAUDE_RUNNER_EXIT_REASON']);
  });

  it('treats a camelCase *Env option as an env site', () => {
    // The session shape: enforcedEnv carries the object into a merge helper.
    const src =
      'function s(){let Zn={CLAUDE_CODE_REMOTE_SESSION_UUID:u},' +
      'Pe=La({inheritedEnv:process.env,enforcedEnv:Zn});return{env:Pe}}';
    expect(names(src)).toEqual(['CLAUDE_CODE_REMOTE_SESSION_UUID']);
  });

  it('reads both arms of a conditional and both sides of a logical spread', () => {
    const src = 'x({env:{...a&&{CLAUDE_A_ONE:"1"},...(b?{CLAUDE_B_TWO:1}:{CLAUDE_C_THREE:1})}})';
    expect(names(src)).toEqual(['CLAUDE_A_ONE', 'CLAUDE_B_TWO', 'CLAUDE_C_THREE']);
  });

  it('resolves a variable in an enclosing function', () => {
    // The checkout hook declares the object outside the Promise callback that spawns.
    const src =
      'async function g(e){let r={CLAUDE_RUNNER_REPO_URL:e.u};' +
      'await new Promise((b)=>{on(e.p,[],{env:r})})}';
    expect(names(src)).toEqual(['CLAUDE_RUNNER_REPO_URL']);
  });

  it('resolves a reused short name to the nearest declaration only', () => {
    // Minified code reuses `n`: the outer one is an unrelated constants table.
    const src =
      'function f(){let n={NOT_AN_ENV_NAME:1};function g(){let n={CLAUDE_INNER:1};' +
      'return{env:n}}return g}';
    expect(names(src)).toEqual(['CLAUDE_INNER']);
  });

  it('reads no property value and no member-access object', () => {
    // `CLAUDE_CODE_VERSION:{…}.VERSION` is one variable whose value is an object, and
    // `O.classes.FormData` is a library option, not an environment.
    const src =
      'let O={classes:{ALPHA_CONST:1}};' +
      'x({env:{...L,CLAUDE_CODE_VERSION:{README_URL:"u",VERSION:"1"}.VERSION}});' +
      'y({env:{FormData:O.classes.FormData}})';
    expect(names(src)).toEqual(['CLAUDE_CODE_VERSION']);
  });

  it('does not read the keys of an object that is a property value', () => {
    expect(names('x({env:{CLAUDE_OUTER:{NESTED_KEY:1}}})')).toEqual(['CLAUDE_OUTER']);
  });

  it('does not follow the object of a member access', () => {
    // `...cfg.table` spreads one property of cfg; cfg's own keys are not in the env.
    expect(names('let cfg={CFG_TABLE:t};x({env:{...cfg.table}})')).toEqual([]);
  });

  it('ignores computed keys, lower-case keys and objects that never reach an env site', () => {
    const src = 'let t={CLAUDE_UNUSED:1};x({env:{[k]:1,cwd:"/",PATH_LIKE:p}})';
    expect(names(src)).toEqual(['PATH_LIKE']);
  });

  it('reads quoted keys', () => {
    expect(names('x({env:{"CLAUDE_QUOTED":"1"}})')).toEqual(['CLAUDE_QUOTED']);
  });

  it('follows at most ENV_FLOW_HOPS declarations', () => {
    // a0 holds the object, and each later variable wraps the one before it.
    const chain = (depth: number) => {
      let src = 'function f(){let a0={CLAUDE_DEEP:1}';
      for (let i = 1; i <= depth; i++) src += `,a${i}=w(a${i - 1})`;
      return `${src};return{env:a${depth}}}`;
    };
    expect(names(chain(ENV_FLOW_HOPS - 1))).toEqual(['CLAUDE_DEEP']);
    expect(names(chain(ENV_FLOW_HOPS))).toEqual([]);
  });

  it('reads through a sequence, parentheses, await and a spread call argument', () => {
    const src =
      'async function f(){let a={CLAUDE_SEQ:1},b={CLAUDE_AWAITED:1},c=[{CLAUDE_SPREAD_ARG:1}];' +
      'x({env:(0,a)});y({env:await b});z({env:m(...c)});w({env:({CLAUDE_PAREN:1})})}';
    // The spread argument is an array, which is not an env shape, so it adds nothing.
    expect(names(src)).toEqual(['CLAUDE_AWAITED', 'CLAUDE_PAREN', 'CLAUDE_SEQ']);
  });

  it('skips numeric keys and a destructured or uninitialised declaration', () => {
    // The regex literal carries a plain `regex` object, which the scope walk must skip.
    const src = 'function f(){let {e}=o,u,r=/a/g;x({env:{1:"a",...e,...u,CLAUDE_KEPT:1}})}';
    expect(names(src)).toEqual(['CLAUDE_KEPT']);
  });

  it('survives a cycle between declarations', () => {
    expect(names('function f(){let a=b,b=a;return{env:a}}')).toEqual([]);
  });
});
