// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker, { prefersMarkdown } from './index.js';

describe('prefersMarkdown', () => {
  it('matches an exact text/markdown request', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
  });

  it('matches when markdown is one range among several', () => {
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(prefersMarkdown('text/html;q=0.9, text/markdown')).toBe(true);
  });

  it('tolerates whitespace, casing and parameters', () => {
    expect(prefersMarkdown('  TEXT/Markdown ; charset=utf-8 ')).toBe(true);
  });

  // The load-bearing case. A browser sends */* on plenty of requests; if that
  // matched, every human visitor would be served a text file instead of the site.
  it('does NOT match a browser Accept header', () => {
    expect(
      prefersMarkdown(
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      )
    ).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/*')).toBe(false);
  });

  it('does not match neighbouring text types', () => {
    expect(prefersMarkdown('text/plain')).toBe(false);
    expect(prefersMarkdown('text/markdown-ish')).toBe(false);
    expect(prefersMarkdown('application/markdown')).toBe(false);
  });

  it('honours q=0 as a refusal', () => {
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0.0')).toBe(false);
  });

  it('treats any nonzero q as acceptance', () => {
    expect(prefersMarkdown('text/markdown;q=0.1')).toBe(true);
    expect(prefersMarkdown('text/markdown;q=1')).toBe(true);
  });

  it('handles a missing or empty header', () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
  });
});

/**
 * The fetch handler decides what every visitor receives, so it is tested
 * directly rather than inferred from prefersMarkdown passing. Origin traffic is
 * stubbed at the global fetch the Worker calls.
 */
describe('fetch handler', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** @param {{ markdown?: Response, page?: Response }} responses */
  function stubOrigin({ markdown, page } = {}) {
    const calls = [];
    globalThis.fetch = vi.fn(async (input) => {
      // The Worker passes a Request for pass-through and a URL for llms.txt.
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith('/llms.txt')) {
        return markdown ?? new Response('# Claustodian\n\nagent guide', { status: 200 });
      }
      return (
        page ??
        new Response('<!doctype html><title>site</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      );
    });
    return calls;
  }

  const get = (accept, init = {}) =>
    new Request('https://claustodian.dev/', {
      headers: accept ? { Accept: accept } : {},
      ...init,
    });

  it('serves Markdown when an agent asks for it', async () => {
    stubOrigin();
    const res = await worker.fetch(get('text/markdown'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('Vary')).toBe('Accept');
    expect(res.headers.get('Content-Location')).toBe('/llms.txt');
    expect(await res.text()).toContain('# Claustodian');
  });

  // The one that matters most: a browser must never be handed a text file.
  it('passes a browser through to the HTML page', async () => {
    stubOrigin();
    const res = await worker.fetch(
      get('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    );
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('marks the HTML branch as varying on Accept too', async () => {
    stubOrigin();
    const res = await worker.fetch(get('text/html'));
    expect(res.headers.get('Vary')).toBe('Accept');
  });

  it('appends to an existing Vary rather than clobbering it', async () => {
    stubOrigin({
      page: new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', Vary: 'Accept-Encoding' },
      }),
    });
    const res = await worker.fetch(get('text/html'));
    expect(res.headers.get('Vary')).toBe('Accept-Encoding, Accept');
  });

  // Regression: a word-boundary regex treats "Accept-Encoding" as already
  // containing "Accept", so the whole header got overwritten with "Accept" and
  // the origin's encoding variance was silently dropped.
  it('does not mistake Accept-Encoding for Accept', async () => {
    stubOrigin({
      page: new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', Vary: 'Accept-Encoding' },
      }),
    });
    const res = await worker.fetch(get('text/html'));
    expect(res.headers.get('Vary')).toContain('Accept-Encoding');
  });

  it('leaves a wildcard Vary alone', async () => {
    stubOrigin({
      page: new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', Vary: '*' },
      }),
    });
    const res = await worker.fetch(get('text/html'));
    expect(res.headers.get('Vary')).toBe('*');
  });

  it('does not duplicate Accept when the origin already varies on it', async () => {
    stubOrigin({
      page: new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', Vary: 'Accept' },
      }),
    });
    const res = await worker.fetch(get('text/html'));
    expect(res.headers.get('Vary')).toBe('Accept');
  });

  it('falls back to HTML when llms.txt cannot be fetched', async () => {
    stubOrigin({ markdown: new Response('nope', { status: 500 }) });
    const res = await worker.fetch(get('text/markdown'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('returns no body for a HEAD request', async () => {
    stubOrigin();
    const res = await worker.fetch(get('text/markdown', { method: 'HEAD' }));
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  it('does not negotiate on a write method', async () => {
    stubOrigin();
    const res = await worker.fetch(
      new Request('https://claustodian.dev/', {
        method: 'POST',
        headers: { Accept: 'text/markdown' },
        body: 'x',
      })
    );
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('routes /mcp to the MCP handler instead of negotiating', async () => {
    stubOrigin();
    const res = await worker.fetch(
      new Request('https://claustodian.dev/mcp', {
        method: 'GET',
        headers: { Accept: 'text/markdown' },
      })
    );
    // The MCP endpoint is POST-only in this revision.
    expect(res.status).toBe(405);
  });
});
