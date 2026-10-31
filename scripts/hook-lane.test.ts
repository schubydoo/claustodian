// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_FLOOR, extractHookEvents } from './hook-lane.js';

/** The list as the bundle writes it, with a name the real bundle renames every release. */
const LIST = 'var qd=["PreToolUse","PostToolUse","Notification","SessionStart","Stop"];';

describe('extractHookEvents', () => {
  it('reads each literal of the hook event list, sorted', () => {
    expect(extractHookEvents(LIST, '2.1.300')).toEqual([
      'Notification',
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
  });

  it('picks the full list over a smaller list of the same names', () => {
    const src = `${LIST} var m=["PreToolUse","PostToolUse"];`;
    expect(extractHookEvents(src, '2.1.300')).toHaveLength(5);
  });

  it('accepts a second copy of the full list, in another chunk', () => {
    expect(extractHookEvents([LIST, LIST.replace('qd', 'EK')], '2.1.300')).toHaveLength(5);
  });

  it('refuses two full-size lists that disagree', () => {
    const other = 'var EK=["PreToolUse","PostToolUse","Notification","SessionStart","Setup"];';
    expect(() => extractHookEvents([LIST, other], '2.1.300')).toThrow(/disagree/);
  });

  it('accepts an array with spreads and dotted names whose events are all in the list', () => {
    const mods = 'var Dn=["PreToolUse","tool.call","Stop",...Ct];';
    expect(extractHookEvents(`${LIST} ${mods}`, '2.1.300')).toHaveLength(5);
  });

  it('refuses an event named beside PreToolUse but missing from the list', () => {
    // The full list moved to a new shape: the old subset would pass as the whole list,
    // and every event only the new shape names would read as removed.
    const src =
      'var m=["PreToolUse","PostToolUse"]; var n=["PreToolUse","PostToolUse",...X,"Stop"];';
    expect(() => extractHookEvents(src, '2.1.300')).toThrow(/Stop/);
  });

  it('refuses a release at or after the floor with no list', () => {
    expect(() => extractHookEvents('var a=1;', HOOK_EVENT_FLOOR)).toThrow(/no hook event list/);
  });

  it('asserts nothing before the floor, even for an array with the list shape', () => {
    expect(extractHookEvents(LIST, '1.0.22')).toEqual([]);
  });
});
