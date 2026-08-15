// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * An MCP server over the published dataset, speaking revision 2026-07-28.
 *
 * That revision is NOT the `initialize` handshake most examples show. It has no
 * sessions, no GET stream, and no handshake at all: every request carries its
 * protocol version in `_meta` and mirrors it into headers, and the server
 * validates the two agree. Written against the spec text, not from memory.
 *
 * Why this exists: claustodian answers "does this symbol exist at this version",
 * which is a lookup an agent should not have to implement by fetching and
 * filtering 700 KB of JSON itself.
 */

export const PROTOCOL_VERSION = '2026-07-28';
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
export const SERVER_INFO = { name: 'claustodian', version: '1.0.0' };

const META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const DATA_BASE = 'https://claustodian.dev/data';

/** Origins allowed to reach this endpoint from a browser. */
const ALLOWED_ORIGINS = new Set(['https://claustodian.dev']);

/** JSON-RPC and MCP-defined error codes actually used here. */
export const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
};

/** A version this dataset could plausibly have. Also the path-traversal guard:
 *  the value is interpolated into a URL, so anything else must never get through. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const isValidVersion = (v) => typeof v === 'string' && VERSION_RE.test(v);

// Every symbol type in schema/symbol.schema.json's `type` enum — including
// control_message and the declared-but-unpublished internal_config_flag. A type
// missing here is rejected by the tool validator below and hidden from its enum,
// so worker/mcp.test.js pins this to the schema to stop it drifting again.
export const SYMBOL_TYPES = [
  'cli_flag',
  'env_var',
  'command',
  'config_key',
  'internal_config_flag',
  'control_message',
];

/**
 * Header values may arrive Base64-wrapped in the spec's sentinel when the raw
 * value is not header-safe. Comparison has to happen after decoding.
 *
 * @param {string | null} value
 * @returns {string | null}
 */
export function decodeHeaderValue(value) {
  if (typeof value !== 'string') return value;
  const match = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!match) return value;
  try {
    // atob yields Latin-1 bytes; reassemble them as UTF-8.
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

/**
 * Server Validation from the transport spec: the mirrored headers must be
 * present and must agree with the body, so an intermediary routing on a header
 * can never disagree with the server executing on the body.
 *
 * @param {Headers} headers
 * @param {any} body
 * @returns {{ code: number, message: string, data?: unknown } | null}
 */
export function validateRequestHeaders(headers, body) {
  const mismatch = (message) => ({ code: ERROR.HEADER_MISMATCH, message });

  const headerVersion = headers.get('mcp-protocol-version');
  if (!headerVersion) return mismatch('Missing required MCP-Protocol-Version header');

  const bodyVersion = body?.params?._meta?.[META_VERSION_KEY];
  if (bodyVersion !== undefined && bodyVersion !== headerVersion) {
    return mismatch(
      `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match body value '${bodyVersion}'`
    );
  }

  const headerMethod = headers.get('mcp-method');
  if (!headerMethod) return mismatch('Missing required Mcp-Method header');
  if (headerMethod !== body?.method) {
    return mismatch(
      `Header mismatch: Mcp-Method '${headerMethod}' does not match body method '${body?.method}'`
    );
  }

  if (body?.method === 'tools/call') {
    const headerName = decodeHeaderValue(headers.get('mcp-name'));
    if (!headerName) return mismatch('Missing required Mcp-Name header for tools/call');
    if (headerName !== body?.params?.name) {
      return mismatch(
        `Header mismatch: Mcp-Name '${headerName}' does not match body value '${body?.params?.name}'`
      );
    }
  }

  return null;
}

export const TOOLS = [
  {
    name: 'list_versions',
    title: 'List tracked Claude Code versions',
    description:
      'Every Claude Code version in the dataset, newest first, plus which one is latest. Use this to discover valid version arguments for the other tools.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        latest: { type: 'string' },
        count: { type: 'integer' },
        versions: { type: 'array', items: { type: 'string' } },
      },
      required: ['latest', 'count', 'versions'],
    },
  },
  {
    name: 'get_symbol',
    title: 'Look up a symbol at a version',
    description:
      'Whether a CLI flag, environment variable, slash command, settings key, or stream-json control message exists in a given Claude Code version, and its full record if so. A version snapshot contains only what was available at that version, so presence is availability — no first_seen arithmetic needed. Omit version to use the newest tracked release. A symbol name can exist as more than one type, so every match is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: "Exact symbol, e.g. '--add-dir', 'ANTHROPIC_API_KEY', '/compact'",
        },
        type: { type: 'string', enum: SYMBOL_TYPES, description: 'Optional type filter' },
        version: {
          type: 'string',
          description: "Claude Code version, e.g. '2.1.226'. Defaults to latest.",
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_symbols',
    title: 'Search symbols at a version',
    description:
      'Case-insensitive substring search over symbol names available at a version. Returns compact records; call get_symbol for the full detail of one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Substring to match' },
        type: { type: 'string', enum: SYMBOL_TYPES, description: 'Optional type filter' },
        version: { type: 'string', description: 'Defaults to latest.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

/**
 * Parsed snapshots are memoised per isolate. The free plan allows 10 ms CPU per
 * invocation and a snapshot costs ~1.4 ms to parse, so a warm isolate answering
 * repeat lookups is the difference between comfortable and marginal. Bounded at
 * two because each parsed snapshot is several MB.
 */
const snapshotCache = new Map();
const SNAPSHOT_CACHE_MAX = 2;

function rememberSnapshot(key, value) {
  if (snapshotCache.size >= SNAPSHOT_CACHE_MAX) {
    snapshotCache.delete(snapshotCache.keys().next().value);
  }
  snapshotCache.set(key, value);
}

/** @param {string} path @returns {Promise<any>} */
async function fetchDataset(path) {
  const response = await fetch(`${DATA_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`dataset fetch failed: ${path} returned ${response.status}`);
  }
  return response.json();
}

/**
 * @param {{ fetchJson?: (path: string) => Promise<any> }} deps
 */
async function loadIndex(deps) {
  const get = deps.fetchJson ?? fetchDataset;
  return get('/index.json');
}

async function loadSnapshot(version, deps) {
  const get = deps.fetchJson ?? fetchDataset;
  if (snapshotCache.has(version)) return snapshotCache.get(version);
  const snapshot = await get(`/versions/${version}.json`);
  rememberSnapshot(version, snapshot);
  return snapshot;
}

/** A tool-execution error: actionable by the model, so isError rather than JSON-RPC. */
const toolError = (text) => ({
  resultType: 'complete',
  content: [{ type: 'text', text }],
  isError: true,
});

const toolOk = (text, structuredContent) => ({
  resultType: 'complete',
  content: [{ type: 'text', text }],
  structuredContent,
  isError: false,
});

/**
 * Resolve the requested version, rejecting anything that is not a real version
 * string BEFORE it reaches a URL.
 *
 * @returns {Promise<{ version: string } | { error: string }>}
 */
async function resolveVersion(requested, deps) {
  if (requested === undefined || requested === null) {
    const index = await loadIndex(deps);
    return { version: index.latest };
  }
  if (!isValidVersion(requested)) {
    return {
      error: `Invalid version '${requested}'. Expected a semver string like '2.1.226'. Call list_versions for valid values.`,
    };
  }
  const index = await loadIndex(deps);
  if (!index.versions.includes(requested)) {
    return {
      error: `Version '${requested}' is not tracked. Call list_versions for the ${index.versions.length} versions that are.`,
    };
  }
  return { version: requested };
}

async function callTool(name, args, deps) {
  const argv = args ?? {};

  if (name === 'list_versions') {
    const index = await loadIndex(deps);
    return toolOk(
      `${index.versions.length} tracked versions, newest ${index.latest}, oldest ${index.versions[index.versions.length - 1]}.`,
      { latest: index.latest, count: index.versions.length, versions: index.versions }
    );
  }

  if (name === 'get_symbol') {
    if (typeof argv.symbol !== 'string' || argv.symbol.length === 0) {
      return toolError("Argument 'symbol' is required and must be a non-empty string.");
    }
    if (argv.type !== undefined && !SYMBOL_TYPES.includes(argv.type)) {
      return toolError(`Invalid type '${argv.type}'. Expected one of: ${SYMBOL_TYPES.join(', ')}.`);
    }
    const resolved = await resolveVersion(argv.version, deps);
    if ('error' in resolved) return toolError(resolved.error);

    const snapshot = await loadSnapshot(resolved.version, deps);
    const matches = snapshot.symbols.filter(
      (s) => s.symbol === argv.symbol && (argv.type === undefined || s.type === argv.type)
    );

    if (matches.length === 0) {
      return toolOk(
        `'${argv.symbol}' is NOT available in Claude Code ${resolved.version}. A snapshot holds every symbol live at that version, so absence here means it did not exist then — it may have been added later or removed earlier.`,
        { available: false, version: resolved.version, symbol: argv.symbol, matches: [] }
      );
    }

    const summary = matches
      .map((m) => `${m.type} ${m.symbol} — ${m.status}, first seen ${m.first_seen}`)
      .join('\n');
    return toolOk(`Available in ${resolved.version}:\n${summary}`, {
      available: true,
      version: resolved.version,
      symbol: argv.symbol,
      matches,
    });
  }

  if (name === 'search_symbols') {
    if (typeof argv.query !== 'string' || argv.query.length === 0) {
      return toolError("Argument 'query' is required and must be a non-empty string.");
    }
    if (argv.type !== undefined && !SYMBOL_TYPES.includes(argv.type)) {
      return toolError(`Invalid type '${argv.type}'. Expected one of: ${SYMBOL_TYPES.join(', ')}.`);
    }
    if (
      argv.limit !== undefined &&
      (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 50)
    ) {
      return toolError("Argument 'limit' must be an integer between 1 and 50.");
    }
    const resolved = await resolveVersion(argv.version, deps);
    if ('error' in resolved) return toolError(resolved.error);

    const limit = argv.limit ?? 20;
    const needle = argv.query.toLowerCase();
    const snapshot = await loadSnapshot(resolved.version, deps);
    const hits = snapshot.symbols.filter(
      (s) =>
        s.symbol.toLowerCase().includes(needle) && (argv.type === undefined || s.type === argv.type)
    );
    const page = hits.slice(0, limit).map((s) => ({
      symbol: s.symbol,
      type: s.type,
      status: s.status,
      first_seen: s.first_seen,
      description: s.description,
    }));

    const text = page.length
      ? `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${resolved.version}${hits.length > page.length ? `, showing ${page.length}` : ''}:\n${page.map((s) => `${s.type} ${s.symbol}`).join('\n')}`
      : `No symbol matching '${argv.query}' in ${resolved.version}.`;

    return toolOk(text, {
      version: resolved.version,
      query: argv.query,
      total: hits.length,
      returned: page.length,
      results: page,
    });
  }

  return null; // unknown tool — the caller turns this into a JSON-RPC error
}

/**
 * Dispatch one JSON-RPC request. Returns the `result` payload, or throws an
 * object shaped like a JSON-RPC error for the transport layer to render.
 *
 * @param {any} body
 * @param {{ fetchJson?: (path: string) => Promise<any> }} [deps]
 */
export async function handleRpc(body, deps = {}) {
  switch (body.method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        instructions:
          'Answers whether a Claude Code CLI flag, environment variable, slash command, settings key, or stream-json control message existed at a specific version. Presence in a version snapshot IS availability at that version. Every record traces to an official Anthropic artifact.',
        ttlMs: 3600000,
        cacheScope: 'public',
      };

    case 'tools/list':
      return { resultType: 'complete', tools: TOOLS, ttlMs: 300000, cacheScope: 'public' };

    case 'tools/call': {
      const name = body?.params?.name;
      const result = await callTool(name, body?.params?.arguments, deps);
      if (result === null) {
        throw { code: ERROR.INVALID_PARAMS, message: `Unknown tool: ${name}` };
      }
      return result;
    }

    default:
      throw { code: ERROR.METHOD_NOT_FOUND, message: `Method not found: ${body.method}` };
  }
}

const json = (payload, status, extraHeaders = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * The MCP endpoint. POST only: this revision removed the GET stream and
 * sessions, so GET and DELETE are 405 and Mcp-Session-Id is ignored.
 *
 * @param {Request} request
 * @param {{ fetchJson?: (path: string) => Promise<any> }} [deps]
 * @returns {Promise<Response>}
 */
export async function handleMcp(request, deps = {}) {
  const origin = request.headers.get('Origin');

  // DNS-rebinding guard required by the transport spec. Non-browser clients
  // send no Origin at all and are unaffected; a browser from another origin
  // could not read the response anyway, since no CORS header is returned to it.
  if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
    return json(rpcError(null, ERROR.INVALID_REQUEST, 'Origin not allowed'), 403);
  }

  const corsHeaders = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    : {};

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return json(rpcError(null, ERROR.INVALID_REQUEST, 'This MCP endpoint accepts POST only'), 405, {
      Allow: 'POST, OPTIONS',
      ...corsHeaders,
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, ERROR.PARSE, 'Request body is not valid JSON'), 400, corsHeaders);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json(
      rpcError(null, ERROR.INVALID_REQUEST, 'Body must be a single JSON-RPC object'),
      400,
      corsHeaders
    );
  }

  const headerError = validateRequestHeaders(request.headers, body);
  if (headerError) {
    return json(rpcError(body.id, headerError.code, headerError.message), 400, corsHeaders);
  }

  const requested = request.headers.get('mcp-protocol-version');
  if (!SUPPORTED_VERSIONS.includes(requested)) {
    return json(
      rpcError(body.id, ERROR.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
        supported: SUPPORTED_VERSIONS,
        requested,
      }),
      400,
      corsHeaders
    );
  }

  // A notification has no id. Accept it and say nothing back.
  if (body.id === undefined) {
    return new Response(null, { status: 202, headers: corsHeaders });
  }

  try {
    const result = await handleRpc(body, deps);
    return json({ jsonrpc: '2.0', id: body.id, result }, 200, corsHeaders);
  } catch (err) {
    if (err && typeof err.code === 'number') {
      // An unimplemented method is a 404 in this revision, so a client can tell
      // it apart from a legacy server that has no MCP endpoint at all.
      const status = err.code === ERROR.METHOD_NOT_FOUND ? 404 : 400;
      return json(rpcError(body.id, err.code, err.message), status, corsHeaders);
    }
    return json(
      rpcError(body.id, ERROR.INVALID_REQUEST, `Server error: ${err?.message ?? 'unknown'}`),
      500,
      corsHeaders
    );
  }
}
