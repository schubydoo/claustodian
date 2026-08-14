// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ERROR,
  PROTOCOL_VERSION,
  TOOLS,
  decodeHeaderValue,
  handleMcp,
  handleRpc,
  isValidVersion,
  validateRequestHeaders,
} from './mcp.js';

/** A dataset stub, so no test touches the network. */
const INDEX = { schemaVersion: 1, latest: '2.1.226', versions: ['2.1.226', '2.1.225', '1.0.18'] };
const SNAPSHOT = {
  claudeCodeVersion: '2.1.226',
  schemaVersion: 1,
  symbols: [
    {
      symbol: '--add-dir',
      type: 'cli_flag',
      first_seen: '1.0.18',
      removed_in: null,
      status: 'active',
      description: 'Add a directory',
    },
    {
      symbol: '--print',
      type: 'cli_flag',
      first_seen: '0.2.30',
      removed_in: null,
      status: 'active',
      description: 'Print mode',
    },
    {
      symbol: 'ANTHROPIC_API_KEY',
      type: 'env_var',
      first_seen: '0.2.21',
      removed_in: null,
      status: 'active',
      description: 'API key',
    },
    // Same name, two types — identity is type:symbol, so both must come back.
    {
      symbol: 'model',
      type: 'config_key',
      first_seen: '1.0.0',
      removed_in: null,
      status: 'active',
      description: 'Model setting',
    },
    {
      symbol: 'model',
      type: 'command',
      first_seen: '1.0.5',
      removed_in: null,
      status: 'active',
      description: 'Model command',
    },
  ],
};

const fetched = [];
const deps = {
  fetchJson: async (path) => {
    fetched.push(path);
    if (path === '/index.json') return INDEX;
    if (path.startsWith('/versions/')) return SNAPSHOT;
    throw new Error(`unexpected path ${path}`);
  },
};

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

function post(body, headerOverrides = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    'Mcp-Method': body.method,
    ...(body.method === 'tools/call' ? { 'Mcp-Name': body.params?.name } : {}),
    ...headerOverrides,
  };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  return new Request('https://claustodian.dev/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('isValidVersion', () => {
  it('accepts a semver triple', () => {
    expect(isValidVersion('2.1.226')).toBe(true);
    expect(isValidVersion('0.2.21')).toBe(true);
  });

  // This is the path-traversal guard: the value goes into a fetch URL.
  it('rejects anything that could escape the data path', () => {
    expect(isValidVersion('../../etc/passwd')).toBe(false);
    expect(isValidVersion('2.1.226/../../secret')).toBe(false);
    expect(isValidVersion('..%2F..%2Fx')).toBe(false);
    expect(isValidVersion('latest')).toBe(false);
    expect(isValidVersion('2.1')).toBe(false);
    expect(isValidVersion('')).toBe(false);
    expect(isValidVersion(null)).toBe(false);
  });
});

describe('decodeHeaderValue', () => {
  it('passes a non-string (absent header) through untouched', () => {
    expect(decodeHeaderValue(null)).toBe(null);
  });

  it('passes plain values through', () => {
    expect(decodeHeaderValue('get_symbol')).toBe('get_symbol');
  });

  it('decodes the base64 sentinel', () => {
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
  });

  it('returns the raw value when the payload is not decodable', () => {
    expect(decodeHeaderValue('=?base64?!!!not base64!!!?=')).toBe('=?base64?!!!not base64!!!?=');
  });
});

describe('validateRequestHeaders', () => {
  const body = rpc('tools/call', { name: 'get_symbol', arguments: {} });

  it('accepts headers that agree with the body', () => {
    const headers = new Headers({
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'get_symbol',
    });
    expect(validateRequestHeaders(headers, body)).toBeNull();
  });

  it('rejects a missing protocol version header', () => {
    const headers = new Headers({ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_symbol' });
    expect(validateRequestHeaders(headers, body)?.code).toBe(ERROR.HEADER_MISMATCH);
  });

  it('rejects a missing Mcp-Method header', () => {
    const headers = new Headers({
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Name': 'get_symbol',
    });
    const result = validateRequestHeaders(headers, body);
    expect(result?.code).toBe(ERROR.HEADER_MISMATCH);
    expect(result?.message).toContain('Missing required Mcp-Method header');
  });

  it('rejects a tools/call without an Mcp-Name header', () => {
    const headers = new Headers({
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
    });
    const result = validateRequestHeaders(headers, body);
    expect(result?.code).toBe(ERROR.HEADER_MISMATCH);
    expect(result?.message).toContain('Missing required Mcp-Name header for tools/call');
  });

  it('rejects a method header that disagrees with the body', () => {
    const headers = new Headers({
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': 'tools/list',
      'Mcp-Name': 'get_symbol',
    });
    expect(validateRequestHeaders(headers, body)?.code).toBe(ERROR.HEADER_MISMATCH);
  });

  it('rejects a name header that disagrees with the body', () => {
    const headers = new Headers({
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'search_symbols',
    });
    expect(validateRequestHeaders(headers, body)?.code).toBe(ERROR.HEADER_MISMATCH);
  });

  it('compares Mcp-Name after decoding the sentinel', () => {
    const named = rpc('tools/call', { name: 'Hello, 世界' });
    const headers = new Headers({
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': '=?base64?SGVsbG8sIOS4lueVjA==?=',
    });
    expect(validateRequestHeaders(headers, named)).toBeNull();
  });

  it('rejects a body _meta version that disagrees with the header', () => {
    const mismatched = rpc('tools/list', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' },
    });
    const headers = new Headers({
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'Mcp-Method': 'tools/list',
    });
    expect(validateRequestHeaders(headers, mismatched)?.code).toBe(ERROR.HEADER_MISMATCH);
  });
});

describe('handleRpc', () => {
  it('implements server/discover with the supported versions', async () => {
    const result = await handleRpc(rpc('server/discover', {}), deps);
    expect(result.supportedVersions).toEqual([PROTOCOL_VERSION]);
    expect(result.resultType).toBe('complete');
    expect(result.capabilities.tools).toBeDefined();
    expect(result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('claustodian');
  });

  it('lists tools with valid schemas', async () => {
    const result = await handleRpc(rpc('tools/list', {}), deps);
    expect(result.tools.map((t) => t.name)).toEqual([
      'list_versions',
      'get_symbol',
      'search_symbols',
    ]);
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('throws method-not-found for an unknown method', async () => {
    await expect(handleRpc(rpc('does/notexist', {}), deps)).rejects.toMatchObject({
      code: ERROR.METHOD_NOT_FOUND,
    });
  });

  it('throws invalid-params for an unknown tool', async () => {
    await expect(
      handleRpc(rpc('tools/call', { name: 'nope', arguments: {} }), deps)
    ).rejects.toMatchObject({ code: ERROR.INVALID_PARAMS });
  });
});

describe('list_versions', () => {
  it('returns every tracked version and the latest', async () => {
    const r = await handleRpc(rpc('tools/call', { name: 'list_versions', arguments: {} }), deps);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.latest).toBe('2.1.226');
    expect(r.structuredContent.count).toBe(3);
  });
});

describe('get_symbol', () => {
  const call = (args) =>
    handleRpc(rpc('tools/call', { name: 'get_symbol', arguments: args }), deps);

  it('reports an available symbol with its record', async () => {
    const r = await call({ symbol: '--add-dir' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.available).toBe(true);
    expect(r.structuredContent.version).toBe('2.1.226');
    expect(r.structuredContent.matches[0].first_seen).toBe('1.0.18');
  });

  it('reports absence without pretending it is an error', async () => {
    const r = await call({ symbol: '--not-a-real-flag' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.available).toBe(false);
    expect(r.content[0].text).toContain('NOT available');
  });

  it('returns every type when a name exists as more than one', async () => {
    const r = await call({ symbol: 'model' });
    expect(r.structuredContent.matches).toHaveLength(2);
    expect(r.structuredContent.matches.map((m) => m.type).sort()).toEqual([
      'command',
      'config_key',
    ]);
  });

  it('filters by type when asked', async () => {
    const r = await call({ symbol: 'model', type: 'command' });
    expect(r.structuredContent.matches).toHaveLength(1);
  });

  it('rejects a missing symbol as a tool error', async () => {
    const r = await call({});
    expect(r.isError).toBe(true);
  });

  it('rejects an unknown type', async () => {
    const r = await call({ symbol: '--add-dir', type: 'not_a_type' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Invalid type');
  });

  it('refuses a traversal attempt in version without fetching it', async () => {
    fetched.length = 0;
    const r = await call({ symbol: '--add-dir', version: '../../../etc/passwd' });
    expect(r.isError).toBe(true);
    expect(fetched.some((p) => p.includes('etc/passwd'))).toBe(false);
  });

  // Every other version test asserts a REJECTION, so without this one the
  // accept path was never proven — a resolver that refused everything would
  // have passed the suite.
  it('accepts an explicit tracked version and queries that snapshot', async () => {
    fetched.length = 0;
    const r = await call({ symbol: '--add-dir', version: '2.1.225' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.version).toBe('2.1.225');
    expect(fetched).toContain('/versions/2.1.225.json');
  });

  it('rejects a well-formed but untracked version', async () => {
    const r = await call({ symbol: '--add-dir', version: '9.9.9' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not tracked');
  });
});

describe('search_symbols', () => {
  const call = (args) =>
    handleRpc(rpc('tools/call', { name: 'search_symbols', arguments: args }), deps);

  it('matches a substring case-insensitively', async () => {
    const r = await call({ query: 'ADD' });
    expect(r.structuredContent.total).toBe(1);
    expect(r.structuredContent.results[0].symbol).toBe('--add-dir');
  });

  it('reports no matches plainly', async () => {
    const r = await call({ query: 'zzzz' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.total).toBe(0);
  });

  it('honours limit and reports the true total', async () => {
    const r = await call({ query: '-', limit: 1 });
    expect(r.structuredContent.returned).toBe(1);
    expect(r.structuredContent.total).toBeGreaterThan(1);
  });

  it('rejects an out-of-range limit', async () => {
    expect((await call({ query: 'a', limit: 0 })).isError).toBe(true);
    expect((await call({ query: 'a', limit: 999 })).isError).toBe(true);
  });

  it('rejects a missing or empty query', async () => {
    expect((await call({})).isError).toBe(true);
    expect((await call({ query: '' })).isError).toBe(true);
  });

  it('filters by a valid type', async () => {
    const all = await call({ query: 'model' });
    const filtered = await call({ query: 'model', type: 'command' });
    expect(all.structuredContent.total).toBe(2);
    expect(filtered.structuredContent.total).toBe(1);
    expect(filtered.structuredContent.results[0].type).toBe('command');
  });

  it('rejects an untracked version here too, not only in get_symbol', async () => {
    const r = await call({ query: 'add', version: '9.9.9' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not tracked');
  });

  it('rejects an unknown type', async () => {
    const r = await call({ query: 'add', type: 'not_a_type' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Invalid type');
  });
});

describe('snapshot memoisation', () => {
  it('reuses a parsed snapshot instead of refetching it', async () => {
    const local = [];
    const localDeps = {
      fetchJson: async (path) => {
        local.push(path);
        return path === '/index.json' ? INDEX : SNAPSHOT;
      },
    };
    const call = (version) =>
      handleRpc(
        rpc('tools/call', { name: 'get_symbol', arguments: { symbol: '--add-dir', version } }),
        localDeps
      );

    await call('2.1.226');
    const afterFirst = local.filter((p) => p === '/versions/2.1.226.json').length;
    await call('2.1.226');
    const afterSecond = local.filter((p) => p === '/versions/2.1.226.json').length;
    expect(afterSecond).toBe(afterFirst);
  });

  // The cache is bounded at two, so a third version must evict the oldest
  // rather than growing without limit — each parsed snapshot is several MB.
  it('evicts once more versions than the bound are requested', async () => {
    const local = [];
    const localDeps = {
      fetchJson: async (path) => {
        local.push(path);
        return path === '/index.json' ? INDEX : SNAPSHOT;
      },
    };
    const call = (version) =>
      handleRpc(
        rpc('tools/call', { name: 'get_symbol', arguments: { symbol: '--add-dir', version } }),
        localDeps
      );

    // Three distinct versions with a bound of two evicts the first.
    await call('2.1.226');
    await call('2.1.225');
    await call('1.0.18');
    const before = local.filter((p) => p === '/versions/2.1.226.json').length;
    await call('2.1.226');
    const after = local.filter((p) => p === '/versions/2.1.226.json').length;
    expect(after).toBe(before + 1);
  });
});

describe('dataset fetching without an injected stub', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('fetches the real data URL and parses it', async () => {
    const seen = [];
    globalThis.fetch = vi.fn(async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify(INDEX), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const r = await handleRpc(rpc('tools/call', { name: 'list_versions', arguments: {} }));
    expect(r.isError).toBe(false);
    expect(seen[0]).toBe('https://claustodian.dev/data/index.json');
  });

  it('loads a snapshot through the real data URL when no fetchJson stub is injected', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(path.startsWith('/data/versions/') ? SNAPSHOT : INDEX), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const r = await handleRpc(
      rpc('tools/call', {
        name: 'get_symbol',
        arguments: { symbol: '--add-dir', version: '2.1.225' },
      })
    );
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('--add-dir');
  });

  it('reports "unknown" when the failure carries no message at all', async () => {
    const throwingDeps = {
      fetchJson: async () => {
        // A bare string, so err.message is undefined in the transport catch.
        throw 'kaput';
      },
    };
    const res = await handleMcp(
      post(rpc('tools/call', { name: 'list_versions', arguments: {} })),
      throwingDeps
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe('Server error: unknown');
  });

  it('surfaces a dataset fetch failure as a 500 rather than a silent wrong answer', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 503 }));
    const res = await handleMcp(post(rpc('tools/call', { name: 'list_versions', arguments: {} })));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain('503');
  });
});

describe('handleMcp transport', () => {
  it('answers a well-formed request', async () => {
    const res = await handleMcp(post(rpc('tools/list', {})), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result.tools).toHaveLength(3);
  });

  it('405s a GET, because this revision removed the GET stream', async () => {
    const res = await handleMcp(
      new Request('https://claustodian.dev/mcp', { method: 'GET' }),
      deps
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toContain('POST');
  });

  it('405s a DELETE, because there are no sessions to terminate', async () => {
    const res = await handleMcp(
      new Request('https://claustodian.dev/mcp', { method: 'DELETE' }),
      deps
    );
    expect(res.status).toBe(405);
  });

  it('403s a foreign Origin', async () => {
    const res = await handleMcp(
      post(rpc('tools/list', {}), { Origin: 'https://evil.example' }),
      deps
    );
    expect(res.status).toBe(403);
  });

  it('allows the site origin', async () => {
    const res = await handleMcp(
      post(rpc('tools/list', {}), { Origin: 'https://claustodian.dev' }),
      deps
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://claustodian.dev');
  });

  it('400s a header/body mismatch with HeaderMismatch', async () => {
    const res = await handleMcp(post(rpc('tools/list', {}), { 'Mcp-Method': 'tools/call' }), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(ERROR.HEADER_MISMATCH);
  });

  it('400s an unsupported version and lists what it supports', async () => {
    const res = await handleMcp(
      post(rpc('tools/list', {}), { 'MCP-Protocol-Version': '1900-01-01' }),
      deps
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(ERROR.UNSUPPORTED_VERSION);
    expect(body.error.data.supported).toEqual([PROTOCOL_VERSION]);
    expect(body.error.data.requested).toBe('1900-01-01');
  });

  // An unknown TOOL is a bad parameter, not a missing method, so it stays 400
  // where an unknown method is 404.
  it('400s an unknown tool, unlike an unknown method', async () => {
    const res = await handleMcp(post(rpc('tools/call', { name: 'no_such_tool' })), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(ERROR.INVALID_PARAMS);
  });

  it('404s an unknown method so a legacy 404 can be told apart', async () => {
    const res = await handleMcp(post(rpc('nope/nope', {})), deps);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe(ERROR.METHOD_NOT_FOUND);
  });

  it('202s a notification with no body', async () => {
    const notification = { jsonrpc: '2.0', method: 'notifications/something', params: {} };
    const res = await handleMcp(post(notification), deps);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('400s a body that is not JSON', async () => {
    const req = new Request('https://claustodian.dev/mcp', {
      method: 'POST',
      headers: { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
      body: 'not json',
    });
    expect((await handleMcp(req, deps)).status).toBe(400);
  });

  it('400s a JSON array body, since batching is not part of this revision', async () => {
    const req = new Request('https://claustodian.dev/mcp', {
      method: 'POST',
      headers: { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'Mcp-Method': 'tools/list' },
      body: '[]',
    });
    expect((await handleMcp(req, deps)).status).toBe(400);
  });

  it('answers an OPTIONS preflight from the allowed origin', async () => {
    const res = await handleMcp(
      new Request('https://claustodian.dev/mcp', {
        method: 'OPTIONS',
        headers: { Origin: 'https://claustodian.dev' },
      }),
      deps
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

describe('tool definitions', () => {
  it('uses names within the spec character set', () => {
    for (const tool of TOOLS) expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
  });

  it('declares no-argument tools as accepting only empty objects', () => {
    const listVersions = TOOLS.find((t) => t.name === 'list_versions');
    expect(listVersions.inputSchema.additionalProperties).toBe(false);
  });
});
