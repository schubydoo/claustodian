// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendDocsCapture,
  assertDocsHistory,
  captureRelease,
  docsTextAt,
  emptyDocsHistory,
  loadDocsHistory,
  type DocsHistory,
} from './docs-history.js';

const capture = (...entries: Array<[string, string]>) => ({
  symbols: entries.map(([symbol, description]) => ({ type: 'env_var', symbol, description })),
});

describe('captureRelease', () => {
  it('takes the newest release either lane knows', () => {
    // A release-bot run: index.json still names the previous release.
    expect(captureRelease(['2.1.329', '2.1.330', '2.1.9'])).toBe('2.1.330');
    // The chunk-split outage: the binary lane is behind the changelog.
    expect(captureRelease(['2.1.246', null, '2.1.242'])).toBe('2.1.246');
  });

  it('refuses to date a capture when no release is known', () => {
    expect(() => captureRelease([undefined, null, ''])).toThrow(/Cannot date a docs capture/);
  });
});

describe('appendDocsCapture', () => {
  it('adds an era only when the text changes', () => {
    let h = appendDocsCapture(emptyDocsHistory(), capture(['A', 'one']), '2.1.1');
    h = appendDocsCapture(h, capture(['A', 'one']), '2.1.2');
    h = appendDocsCapture(h, capture(['A', 'two']), '2.1.3');
    expect(h.descriptions['env_var:A']).toEqual([
      { from: '2.1.1', description: 'one' },
      { from: '2.1.3', description: 'two' },
    ]);
  });

  it('replaces the era of the same release, and collapses an era that comes back', () => {
    let h = appendDocsCapture(emptyDocsHistory(), capture(['A', 'one']), '2.1.1');
    h = appendDocsCapture(h, capture(['A', 'two']), '2.1.2');
    h = appendDocsCapture(h, capture(['A', 'three']), '2.1.2');
    expect(h.descriptions['env_var:A']).toEqual([
      { from: '2.1.1', description: 'one' },
      { from: '2.1.2', description: 'three' },
    ]);
    h = appendDocsCapture(h, capture(['A', 'one']), '2.1.2');
    expect(h.descriptions['env_var:A']).toEqual([{ from: '2.1.1', description: 'one' }]);
  });

  it('records a null era when the docs stop documenting a symbol', () => {
    let h = appendDocsCapture(emptyDocsHistory(), capture(['A', 'one'], ['B', 'b']), '2.1.1');
    h = appendDocsCapture(h, capture(['B', 'b']), '2.1.2');
    h = appendDocsCapture(h, capture(['B', 'b']), '2.1.3');
    h = appendDocsCapture(h, capture(['A', 'one'], ['B', 'b']), '2.1.4');
    expect(h.descriptions['env_var:A']).toEqual([
      { from: '2.1.1', description: 'one' },
      { from: '2.1.2', description: null },
      { from: '2.1.4', description: 'one' },
    ]);
  });

  it('never starts a timeline with a null era', () => {
    let h = appendDocsCapture(emptyDocsHistory(), capture(['A', 'one'], ['B', 'b']), '2.1.1');
    h = appendDocsCapture(h, capture(['B', 'b']), '2.1.1');
    expect(h.descriptions['env_var:A']).toBeUndefined();
  });

  it('refuses a capture older than the newest era', () => {
    const h = appendDocsCapture(emptyDocsHistory(), capture(['A', 'one']), '2.1.5');
    expect(() => appendDocsCapture(h, capture(['A', 'two']), '2.1.4')).toThrow(
      /older than the timeline's era 2\.1\.5/
    );
  });
});

describe('docsTextAt', () => {
  const eras = [
    { from: '2.1.10', description: 'old' },
    { from: '2.1.20', description: null },
    { from: '2.1.30', description: 'new' },
  ];

  it('returns the era in effect, and the first era before the timeline', () => {
    expect(docsTextAt(eras, '2.1.15')).toEqual({
      text: 'old',
      from: '2.1.10',
      contemporaneous: true,
    });
    expect(docsTextAt(eras, '2.1.5')).toEqual({
      text: 'old',
      from: '2.1.10',
      contemporaneous: false,
    });
    // A null era is an answer too: the docs of that time had no text.
    expect(docsTextAt(eras, '2.1.25')).toEqual({ text: '', from: '2.1.20', contemporaneous: true });
    expect(docsTextAt(eras, '2.1.40')?.text).toBe('new');
    expect(docsTextAt([], '2.1.1')).toBeUndefined();
  });

  it('takes a later era that names a change this version already carries', () => {
    const lag = [
      { from: '2.1.306', description: 'A hooks module is about to load.' },
      { from: '2.1.330', description: 'A module, or, on v2.1.326 or later, a plugin.' },
    ];
    const named = (text: string) => (text.includes('2.1.326') ? '2.1.326' : null);
    expect(docsTextAt(lag, '2.1.325', named)?.text).toBe('A hooks module is about to load.');
    expect(docsTextAt(lag, '2.1.326', named)).toEqual({
      text: 'A module, or, on v2.1.326 or later, a plugin.',
      from: '2.1.330',
      contemporaneous: true,
    });
    // Of two eras that caught up, the nearer one: the newer can describe more.
    const two = [...lag, { from: '2.1.340', description: 'Newest, with 2.1.326.' }];
    expect(docsTextAt(two, '2.1.327', named)?.from).toBe('2.1.330');
    // A version the era in effect already knew about is no evidence of a lag.
    const stale = () => '2.1.300';
    expect(docsTextAt(lag, '2.1.326', stale)?.text).toBe('A hooks module is about to load.');
  });
});

describe('assertDocsHistory / loadDocsHistory', () => {
  const valid = (): DocsHistory => ({
    ...emptyDocsHistory(),
    descriptions: { 'env_var:A': [{ from: '2.1.1', description: 'one' }] },
  });

  it('accepts a well-formed file and refuses each malformed shape', () => {
    expect(() => assertDocsHistory(valid(), 'p')).not.toThrow();
    expect(() => assertDocsHistory({ ...valid(), $generated_by: 'x' }, 'p')).toThrow(
      /is not a scripts\/fetch-docs\.ts output/
    );
    const bad = (eras: unknown) =>
      assertDocsHistory({ ...valid(), descriptions: { k: eras } } as unknown as DocsHistory, 'p');
    expect(() => bad([])).toThrow(/k has no eras/);
    expect(() => bad([{ from: '2.1.1', description: 3 }])).toThrow(/string or null/);
    expect(() =>
      bad([
        { from: '2.1.2', description: 'a' },
        { from: '2.1.1', description: 'b' },
      ])
    ).toThrow(/out of order/);
    expect(() =>
      assertDocsHistory({ ...valid(), descriptions: null } as unknown as DocsHistory, 'p')
    ).toThrow(/"descriptions" is not an object/);
  });

  it('reads a missing file as absent and a present one as checked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claustodian-docs-history-'));
    try {
      expect(await loadDocsHistory(join(dir, 'missing.json'))).toBeUndefined();
      const path = join(dir, 'docs-history.json');
      await writeFile(path, JSON.stringify(valid()), 'utf-8');
      expect((await loadDocsHistory(path))?.descriptions['env_var:A']).toHaveLength(1);
      await writeFile(path, JSON.stringify({ ...valid(), source: 'binary' }), 'utf-8');
      await expect(loadDocsHistory(path)).rejects.toThrow(
        /is not a scripts\/fetch-docs\.ts output/
      );
      await expect(loadDocsHistory(dir)).rejects.toThrow(/Cannot read docs history/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
