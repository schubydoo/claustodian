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

  it('keeps two blocks that reuse a name apart', () => {
    const src =
      'function f(){if(a){let n={CLAUDE_ONE:1};spawn("x",[],{env:n})}' +
      'if(b){let n={CLAUDE_TWO:1};spawn("x",[],{env:n})}}';
    expect(names(src)).toEqual(['CLAUDE_ONE', 'CLAUDE_TWO']);
  });

  it('lets a parameter, a catch parameter or a bare declaration hide an outer name', () => {
    const src =
      'let n={OUTER_TABLE:1};function f(n){return{env:n}}' +
      'function g(){try{}catch(n){x({env:n})}}function h(){let n;return{env:n}}' +
      'function k(){let {n}=o;return{env:n}}';
    expect(names(src)).toEqual([]);
  });

  it('lets every name of a destructuring pattern, and a class, hide an outer name', () => {
    const outer = ['a', 'd', 'e', 'f', 'g', 'h', 'k'].map((n) => `${n}={OUT_${n}:1}`).join(',');
    const src =
      `let ${outer};` +
      'function p(a,{b,c:d,...e},[f,,...g],h=1){return{env:{...a,...d,...e,...f,...g,...h}}}' +
      '{class k{}x({env:k})}' +
      'const arrow=()=>({env:{CLAUDE_ARROW:1}});';
    expect(names(src)).toEqual(['CLAUDE_ARROW']);
  });

  it('keeps a var value through a repeated bare var, but not through a bare let', () => {
    expect(names('function f(){var n={CLAUDE_CHILD:1};var n;return{env:n}}')).toEqual([
      'CLAUDE_CHILD',
    ]);
    expect(names('function f(){let n={OUTER_N:1};{let n;x({env:n})}}')).toEqual([]);
  });

  it('binds a var to its function, and a function expression name inside it only', () => {
    const src =
      'function f(){if(a){var v={CLAUDE_HOISTED:1}}return{env:v}}' +
      'let q={OUTER_Q:1};const r=function q(){return{env:q}};';
    expect(names(src)).toEqual(['CLAUDE_HOISTED']);
  });

  it('resolves a name in an initialiser where that declaration is written', () => {
    // At the site, `n` is the inner table; the outer `p` was declared with the outer `n`.
    const src =
      'function f(){let n={CLAUDE_OUTER_N:1},p=w(n);function g(){let n={INNER_N:1};' +
      'return{env:p}}return g}';
    expect(names(src)).toEqual(['CLAUDE_OUTER_N']);
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
