# Authentication

**There is none, and none is planned.** Every endpoint on
<https://claustodian.dev> is public, anonymous and unmetered. No API key, no
token, no OAuth flow, no sign-up, no `Authorization` header. If a client is
holding a credential for this host, it is holding it for nothing.

This page exists because "no authentication" is worth stating explicitly. An
agent that cannot tell the difference between _open_ and _not yet configured_
will otherwise go looking for a key, or refuse to call a perfectly public
endpoint.

## What that means in practice

| Question             | Answer                                             |
| -------------------- | -------------------------------------------------- |
| Credentials required | None, on every endpoint including `/mcp`           |
| Rate limits          | None imposed by this site                          |
| CORS                 | `Access-Control-Allow-Origin: *` on the data files |
| Cost                 | Free. There is no billing relationship to enter    |
| Terms                | The data is CC-BY-4.0; see the licence links below |

There is no OAuth metadata at `/.well-known/oauth-authorization-server` or
`/.well-known/oauth-protected-resource`, and none should be published: there is
no authorization server and no protected resource. An absent document is the
honest answer to a question about a service that does not exist.

## Endpoints, all unauthenticated

- `https://claustodian.dev/data/index.json` — every tracked version
- `https://claustodian.dev/data/latest.json` — newest full snapshot
- `https://claustodian.dev/data/versions/<X.Y.Z>.json` — snapshot at a version
- `https://claustodian.dev/data/catalog.json` — every symbol ever seen
- `https://claustodian.dev/mcp` — MCP server, revision `2026-07-28`
- `https://claustodian.dev/llms.txt` — the agent guide

## Being a good citizen

Nothing here is enforced, so it is a request rather than a rule:

- Cache. The dataset changes at most a few times a day, and every response
  carries cache headers that say so.
- Fetch the one version you need rather than walking all 359 snapshots. If you
  genuinely need the whole corpus, clone
  <https://github.com/schubydoo/claustodian> instead — it is the same data.
- Identify yourself in a `User-Agent` if you are automating at volume. Not
  required, and nothing is blocked without it.

## Licence and provenance

The data is [CC-BY-4.0](https://github.com/schubydoo/claustodian/blob/main/LICENSE-DATA);
the code is Apache-2.0. Every record derives from an official public Anthropic
artifact — the changelog, the documentation, or a release binary — and carries
its own `provenance` and `confidence` fields so you can judge it yourself.

Issues and questions: <https://github.com/schubydoo/claustodian/issues>.
