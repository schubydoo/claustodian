// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Content negotiation for the site root.
 *
 * An agent that sends `Accept: text/markdown` to https://claustodian.dev/ gets
 * llms.txt instead of the HTML page. Everyone else is passed straight through.
 *
 * Why llms.txt rather than a conversion of the page: the HTML is a shell whose
 * symbol table is rendered client-side from data/*.json. Converting it would
 * hand an agent the navigation and none of the dataset. llms.txt is written for
 * this audience, is already published, and cannot drift from itself.
 *
 * The Worker is deliberately routed at the root path ONLY. Nothing under /data
 * reaches it, so the dataset keeps being served directly by Pages, and the
 * llms.txt subrequest below cannot re-enter this Worker.
 */

import { handleMcp } from './mcp.js';

const MARKDOWN_SOURCE = '/llms.txt';
const MCP_PATH = '/mcp';

/**
 * True when the client explicitly asked for Markdown.
 *
 * Deliberately strict: only an exact `text/markdown` media range counts. The
 * wildcard range a browser sends must NOT match, or every visitor gets a text
 * file instead of the site. A `q=0` on the range means "not acceptable" per
 * RFC 9110 and is honoured as a refusal.
 *
 * @param {string | null} acceptHeader
 * @returns {boolean}
 */
export function prefersMarkdown(acceptHeader) {
  if (!acceptHeader) return false;

  for (const range of acceptHeader.split(',')) {
    const [rawType, ...params] = range.trim().split(';');
    if (rawType.trim().toLowerCase() !== 'text/markdown') continue;

    const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    if (q && Number.parseFloat(q.slice(2)) === 0) return false;

    return true;
  }

  return false;
}

/**
 * `Vary: Accept` has to be on BOTH branches. Without it on the HTML response a
 * shared cache can hand a stored HTML body to a client that asked for Markdown,
 * and vice versa — the negotiation would appear to work and then fail once
 * anything is cached in front of it.
 *
 * @param {Response} response
 * @returns {Response}
 */
function withVaryAccept(response) {
  const varied = new Response(response.body, response);
  const existing = varied.headers.get('Vary');

  // `Vary: *` already means "varies on everything"; narrowing it would be a lie.
  if (existing && existing.trim() === '*') return varied;

  // Compare parsed field names, never a substring. A regex word match treats
  // `Accept-Encoding` as containing `Accept` — there is a word boundary at the
  // hyphen — so it would conclude Accept was already listed and overwrite the
  // whole header, dropping the origin's encoding variance.
  const fields = (existing ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  if (!fields.some((f) => f.toLowerCase() === 'accept')) fields.push('Accept');
  varied.headers.set('Vary', fields.join(', '));
  return varied;
}

export default {
  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    // The MCP endpoint is its own protocol and shares nothing with content
    // negotiation beyond the Worker. It is routed separately too, so this only
    // matters for defence in depth if the routes are ever widened.
    if (new URL(request.url).pathname === MCP_PATH) {
      return handleMcp(request);
    }

    const accept = request.headers.get('Accept');
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const wantsMarkdown = isRead && prefersMarkdown(accept);

    // Logged because a third-party readiness scanner reports that negotiation
    // fails, while every request made by hand succeeds. Observability confirms
    // the Worker runs for its requests, so whatever Accept it actually sends is
    // the missing fact — and it is not visible from outside. Header value only:
    // no path, no IP, nothing identifying.
    console.log(JSON.stringify({ negotiation: wantsMarkdown ? 'markdown' : 'html', accept }));

    if (!wantsMarkdown) {
      return withVaryAccept(await fetch(request));
    }

    const source = new URL(MARKDOWN_SOURCE, request.url);
    const upstream = await fetch(source, {
      headers: { Accept: 'text/plain' },
    });

    // Fall back to the HTML page rather than serving an error. A negotiation
    // that cannot be satisfied should degrade to the representation that does
    // exist, not turn a working page into a 5xx.
    if (!upstream.ok) return withVaryAccept(await fetch(request));

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        Vary: 'Accept',
        // Points at the representation actually returned, so a client can tell
        // this body has its own stable URL.
        'Content-Location': MARKDOWN_SOURCE,
        'Cache-Control': 'max-age=600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};
