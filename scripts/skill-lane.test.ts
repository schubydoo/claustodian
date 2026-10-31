import { describe, expect, it } from 'vitest';
import { parse } from './control-lane.js';
import { collectSkillEvidence, resolveVariableSkills } from './skill-lane.js';

const skills = (...chunks: string[]) =>
  resolveVariableSkills(chunks.map((c) => collectSkillEvidence(parse(c))));

describe('resolveVariableSkills', () => {
  it('resolves a name bound in the same chunk, with its description and aliases', () => {
    const src =
      'var Skt="loop";x({name:Skt,menuDescription:"Repeat a prompt",aliases:["proactive","Bad"]});';
    expect(skills(src)).toEqual([
      { symbol: '/loop', alias: false, description: 'Repeat a prompt' },
      { symbol: '/proactive', alias: true },
    ]);
  });

  it('follows an import to the one chunk that exports the name', () => {
    const owner = 'var Moi="setup-claude",z=1;export{Moi,z as Z};';
    const user =
      'import{Moi as m,Z}from"/$bunfs/root/chunk-ppg.js";' +
      'el({name:m,aliases:["setup-cowork"],menuDescription:`Guided setup`});';
    expect(skills(owner, user)).toEqual([
      { symbol: '/setup-claude', alias: false, description: 'Guided setup' },
      { symbol: '/setup-cowork', alias: true },
    ]);
  });

  it('skips a built-in workflow, which carries whenToUse and phases', () => {
    const src =
      'function VG(H,$){w.push({source:"built-in",...$,script:H})}' +
      'var te7="autopilot",ee7="An end-to-end task runner";' +
      'VG(`script`,{name:te7,description:ee7,whenToUse:"w",phases:[{title:"Plan"}]});';
    expect(skills(src)).toEqual([]);
  });

  it('needs the menuDescription or whenToUse marker', () => {
    expect(skills('var a="crmsh";x({name:a,aliases:["crm"],keywords:1})')).toEqual([]);
    expect(skills('var a="dream";x({name:a,whenToUse:"When idle"})')).toEqual([
      { symbol: '/dream', alias: false },
    ]);
  });

  it('refuses a name that is reassigned, bound to a non-literal, or off-grammar', () => {
    const marker = 'menuDescription:"m"';
    expect(skills(`var a="one";a="two";x({name:a,${marker}})`)).toEqual([]);
    expect(skills(`var a="one";a+="s";x({name:a,${marker}})`)).toEqual([]);
    expect(skills(`var a=f();x({name:a,${marker}})`)).toEqual([]);
    expect(skills(`var a="one";a=f();x({name:a,${marker}})`)).toEqual([]);
    expect(skills(`var a="Not A Skill";x({name:a,${marker}})`)).toEqual([]);
    expect(skills(`x({name:unbound,${marker}})`)).toEqual([]);
    // A repeat of the same literal is one binding, and `let a;` binds nothing yet.
    expect(skills(`var a="same";let b;a="same";x({name:a,${marker}})`)).toEqual([
      { symbol: '/same', alias: false, description: 'm' },
    ]);
  });

  it('follows no import whose module is ambiguous or unexported', () => {
    const marker = 'menuDescription:"m"';
    const a = 'var n="from-a";export{n};';
    const b = 'var n="from-b";export{n};';
    const user = `import{n}from"/$bunfs/root/chunk-x.js";x({name:n,${marker}});`;
    expect(skills(a, b, user)).toEqual([]);
    const hidden = 'var n="hidden";export{q};var q=1;';
    const user2 = `import{q,n}from"/$bunfs/root/chunk-y.js";x({name:n,${marker}});`;
    expect(skills(hidden, user2)).toEqual([]);
  });

  it('skips a re-export facade, a namespace import and a getter-only name', () => {
    const marker = 'menuDescription:"m"';
    const owner = 'var n="real";export{n};';
    const facade = 'export{n}from"/$bunfs/root/chunk-z.js";import*as ns from"/x.js";';
    const user = `import{n}from"/$bunfs/root/chunk-z.js";x({name:n,${marker}});`;
    expect(skills(owner, facade, user)).toEqual([
      { symbol: '/real', alias: false, description: 'm' },
    ]);
    expect(skills(`var n="g";x({get name(){return n},${marker}})`)).toEqual([]);
  });

  it('takes the description in the literal rule order and keeps the first per name', () => {
    const src =
      'var a="one",b="two",c="three",d="four";' +
      'x({name:a,whenToUse:"w",description:"plain"});' +
      'x({name:b,whenToUse:"w",get description(){return "from getter"}});' +
      'x({name:c,whenToUse:"w",description:`${t} dynamic`});' +
      'x({name:d,whenToUse:"w"});x({name:d,whenToUse:"w",description:"later"});' +
      'x({name:a,whenToUse:"w",description:"ignored"});';
    expect(skills(src)).toEqual([
      { symbol: '/four', alias: false, description: 'later' },
      { symbol: '/one', alias: false, description: 'plain' },
      { symbol: '/three', alias: false },
      { symbol: '/two', alias: false, description: 'from getter' },
    ]);
  });

  it('reads a quoted key and skips computed keys, destructuring and member writes', () => {
    const marker = 'menuDescription:"m"';
    expect(skills(`var a="quoted";x({[k]:1,2:3,"name":a,${marker}})`)).toEqual([
      { symbol: '/quoted', alias: false, description: 'm' },
    ]);
    expect(
      skills(`var {a}=o,b="kept";o.b="x";x({name:b,${marker}});x({[name]:a,${marker}})`)
    ).toEqual([{ symbol: '/kept', alias: false, description: 'm' }]);
  });

  it('resolves by scope: a parameter or a destructured name hides an outer literal', () => {
    // From review: the outer `n` is not the name this function registers.
    const marker = 'menuDescription:"m"';
    expect(
      skills(`var n="unrelated";function register(n){x({name:n,${marker}})}register("actual");`)
    ).toEqual([]);
    expect(skills(`var n="outer";function f({n}){x({name:n,${marker}})}`)).toEqual([]);
    expect(skills(`var n="outer";function f(){let n="inner";x({name:n,${marker}})}`)).toEqual([
      { symbol: '/inner', alias: false, description: 'm' },
    ]);
    // A write to an inner `n` leaves the outer binding as it was.
    expect(skills(`var n="outer";function f(n){n="x"}o.n++;x({name:n,${marker}})`)).toEqual([
      { symbol: '/outer', alias: false, description: 'm' },
    ]);
    expect(skills(`var n="counted";n++;x({name:n,${marker}})`)).toEqual([]);
    expect(skills(`var n="dd";({n}=o);x({name:n,${marker}})`)).toEqual([]);
    expect(skills(`var n="dd";[n]=a;x({name:n,${marker}})`)).toEqual([]);
    expect(skills(`var n="dd";for(n of xs);x({name:n,${marker}})`)).toEqual([]);
    expect(skills(`var n="dd";for(let n of xs);x({name:n,${marker}})`)).toEqual([
      { symbol: '/dd', alias: false, description: 'm' },
    ]);
  });

  it('rejects an entry whose name a later key can replace', () => {
    const marker = 'menuDescription:"m"';
    expect(skills(`var n="old";x({name:n,...{name:"actual"},${marker}})`)).toEqual([]);
    expect(skills(`var n="old";x({name:n,[k]:1,${marker}})`)).toEqual([]);
    expect(skills(`var n="old";x({name:n,name:"actual",${marker}})`)).toEqual([]);
    expect(skills(`var n="old";x({name:"actual",name:n,${marker}})`)).toEqual([]);
    // A spread BEFORE the name cannot replace it.
    expect(skills(`var n="kept";x({...base,name:n,${marker}})`)).toEqual([
      { symbol: '/kept', alias: false, description: 'm' },
    ]);
  });

  it('does not follow an exported import into a third chunk', () => {
    const marker = 'menuDescription:"m"';
    const origin = 'var n="deep";export{n};';
    const relay = 'import{n}from"/origin.js";export{n as m};';
    const user = `import{m}from"/relay.js";x({name:m,${marker}});`;
    expect(skills(origin, relay, user)).toEqual([]);
  });

  it('does not list an alias that is also a registered name', () => {
    const src =
      'var a="code-review",b="review";x({name:a,whenToUse:"w",aliases:["review"]});' +
      'x({name:b,whenToUse:"w"});';
    expect(skills(src).map((s) => `${s.symbol}:${s.alias}`)).toEqual([
      '/code-review:false',
      '/review:false',
    ]);
  });
});
