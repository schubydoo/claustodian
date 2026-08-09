# Runbook — publishing and the custom domain

The site at **https://claustodian.dev** is built and deployed by
`.github/workflows/publish-pages.yml` on every push to `main` that touches `data/`,
`schema/`, `site/`, `llms.txt`, the brand assets, or the workflow itself.

**Who can run this:** the deploy is automatic. Re-running it and changing domain
settings need repo admin.

---

## What the workflow does

1. `npm ci`, `npm run validate`
2. `npm run generate-exports` — YAML/TOML siblings for every `data/**/*.json`
3. `npm run build-catalog` — `data/catalog.json`
4. Assembles `_site/`: `data/`, `site/index.html`, `site/review/`, `favicon.svg`,
   `og-image.png`, `llms.txt`, `robots.txt`, `sitemap.xml`, `.well-known/`
5. Deploys via `actions/deploy-pages` using OIDC — no stored credential

> **`.well-known/` needs `include-hidden-files: 'true'` on the upload step.**
> `actions/upload-pages-artifact` tars `_site` with `--exclude=.[^/]*` otherwise,
> which drops every dot-entry — the copy lands in `_site`, never reaches the
> artifact, and the deploy still reports success. This, not Jekyll, is why "Pages
> cannot serve `.well-known`" is common advice; a `.nojekyll` file fixes nothing
> here because this deploy never runs Jekyll. A guard in the assemble step fails
> the build if any dot-entry other than `.well-known` would be published.

Generated exports and the catalog are gitignored; they exist only in the built site.

> **Step order matters:** `generate-exports` runs _before_ `build-catalog`, so
> `catalog.json` has no `.yaml`/`.toml` sibling. That is documented in the README and
> `llms.txt` as the one exception to extension-swapping. If you ever want those
> formats, swap the two steps — do not paper over it in the docs.

---

## The trap: Pages does not rebuild on a domain change

**Actions-built Pages does not redeploy when you change the custom domain.** Setting
or changing it leaves the site serving GitHub's "Site not found" 404 on the new
domain, while the _old_ `github.io` URL keeps working — so the failure looks like DNS.

Check the Pages API alongside the site itself:

```bash
gh api repos/schubydoo/claustodian/pages --jq '{status, cname, protected_domain_state}'
curl -sSL -o /dev/null -w '%{http_code}\n' https://claustodian.dev/
```

> **`status: null` on its own means nothing.** It is null on healthy Actions-built
> Pages too — verified on 2026-08-09, with the site serving every endpoint and the
> newest version. What identifies the trap is `status: null` **together with** a
> domain that is not serving while the `github.io` URL still is. Do not re-run a
> deploy on the strength of the API field alone.

The fix is to re-run the publish workflow:

```bash
gh run list --repo schubydoo/claustodian --workflow publish-pages.yml --limit 1
gh run rerun <id> --repo schubydoo/claustodian
```

No `CNAME` file is needed or wanted. Per GitHub's docs, for a custom Actions workflow
"no CNAME file is created, and any existing CNAME file is ignored" — the domain lives
in repo Settings.

---

## Verifying a deploy — and why local curl lies

Two traps, both hit on 2026-08-08:

**Fastly caches per edge.** This host resolves to one region and will happily serve a
stale `200` while the rest of the world gets a 404. Always read the cache headers:

```bash
curl -sSI https://claustodian.dev/ | grep -iE '^HTTP|x-cache|age|last-modified'
```

`x-cache: HIT` with a nonzero `age` proves nothing about current state. Look for
`MISS` and `age: 0`.

**Query strings do not bust the Pages cache.** `?probe=1` is normalised away, so
"cache-busted" probes re-read the same object. Ten green 200s can all be the same
stale object.

**Use a second vantage point.** Anything fetching from different infrastructure — a
phone on cellular, or a `WebFetch`-style tool — is the cheapest independent check.

Run the scripted checks:

```bash
bash scripts/check-publish.sh
```

---

## Redirects and compatibility

The old `https://schubydoo.github.io/claustodian` base 301-redirects to the custom
domain with the path preserved, so a client that follows redirects keeps working. A
bare `curl` without `-L` gets the redirect page instead of JSON — worth stating in any
consumer-facing example.

---

## If something goes wrong

| Symptom                                         | Check                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Domain serves "Site not found", github.io works | `status: null` from the Pages API. Re-run the publish workflow.    |
| Site looks stale but the run succeeded          | `x-cache`/`age` — you are reading a warm edge, not the origin.     |
| `catalog.yaml` 404s                             | Expected. It is built after the export step. Not a bug.            |
| A data file 404s that should exist              | Confirm it is inside `data/` and that the assemble step copies it. |
| `www` does not resolve                          | `www` is a proxied CNAME to `schubydoo.github.io`; origin 301s it. |
| Root serves plain text to a browser             | The Worker below mis-read `Accept`. Disable the route to revert.   |

---

## Cloudflare sits in front, and it is not in this repo

Pages is the origin; Cloudflare proxies it. Four things are configured there and
nothing in this repository would tell you they exist. **Anything under
`.well-known/` needs a media-type rule**: those files are extensionless by
specification, and Pages serves an extensionless file as
`application/octet-stream`, so adding one to `site/.well-known/` is only half the
job.

| Where                                     | What                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| Response header rule, phase `…_transform` | `Link: rel=canonical` + `rel=describedby` on `/`                           |
| Response header rule, same ruleset        | `Content-Type: application/linkset+json` on `/.well-known/api-catalog`     |
| Response header rule, same ruleset        | `Content-Type: application/json` on `/.well-known/mcp-server-card`         |
| Worker `claustodian-site`, route `/`      | `Accept: text/markdown` on the root returns `llms.txt` (`worker/index.js`) |
| Same Worker, route `/mcp`                 | MCP server over the dataset, revision 2026-07-28 (`worker/mcp.js`)         |

Two traps, both survived once already:

- **A response header must live in the `http_response_headers_transform` phase.**
  `http_request_late_transform` is the _request_ phase — a `Link` rule placed there
  is attached to the request Cloudflare makes to GitHub, which ignores it, and no
  visitor ever sees the header. Both rules look identical in the dashboard.
- **Rule changes take up to a couple of minutes to reach every edge machine.** The
  first verifying `curl` after a change can legitimately come back wrong. Sample
  ~20 times before concluding anything; a 6-of-8 result is propagation, not a bug.
- **A Worker route is matched against the whole URL, query string included.** The
  route `claustodian.dev/` therefore covers `https://claustodian.dev/` and **not**
  `https://claustodian.dev/?cb=1`. There is no pattern that fixes this: Cloudflare
  rejects a `?` inside a route pattern with API error 10022. The only full-coverage
  option is `claustodian.dev/*` plus a pathname guard in the Worker, which routes
  every data file through it — deliberately not done.

  This one is a trap for verification, not just for config. The habit of appending
  `?cb=$RANDOM` to defeat caches **silently disables the Worker**, so a working
  deployment reads as broken. Test the root with a bare URL, and send a no-cache
  request header if you need freshness. Measured 20/20 bare against 0/20 with a
  query string, then 8/8 alternating pairs in one run.

### The MCP endpoint

`worker/mcp.js` serves MCP revision **2026-07-28** at `/mcp`. That revision is not
the `initialize` handshake most examples show — it has no sessions and no GET
stream, every request carries its version in `_meta` and mirrors it into headers,
and the server rejects a request whose headers and body disagree. Write against
the spec, not against an older example.

**The free plan's 10 ms CPU budget decides which tools can exist.** Measured parse
costs: `index.json` 0.03 ms, a version snapshot 1.4 ms, `binary-descriptions.json`
2.3 ms, and **`catalog.json` 10.5 ms** — the whole budget on its own. So no tool
answers "did this symbol ever exist", which is the only question needing the
catalog. Per-version tools are cheap because a snapshot holds exactly what was
live at that version, so presence is availability.

### Deploying the Worker

`.github/workflows/deploy-worker.yml` deploys it on every push to `main` touching
`worker/**`. Pull requests get a `--dry-run` that bundles the Worker without
credentials, so a fork PR is safe and a syntax error never reaches `main`.

The deploy job does not trust a green `wrangler deploy`. It asserts three things
against the live domain afterwards: Markdown is negotiated, a browser `Accept`
still gets HTML, and `/data/index.json` is still plain JSON — the last one proving
the Worker is not sitting in front of the dataset.

**Those checks use bare URLs on purpose.** A `?cb=` cache-buster bypasses the route
(see the trap above) and would fail the check on a perfectly good deploy.

Two secrets are required, and the workflow fails without them:

| Secret                  | Value                                    |
| ----------------------- | ---------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | scoped token, permissions below          |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID the Worker is deployed to |

Mint the token at **My Profile → API Tokens → Create Token → Create Custom Token**
with the narrowest scope that works:

- **Account → Workers Scripts → Edit** — upload the script
- **Zone → Workers Routes → Edit**, zone `claustodian.dev` — manage the route

Do not use the "Edit Cloudflare Workers" template: it also grants KV, R2 and
Durable Objects, none of which this Worker uses. Then:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo schubydoo/claustodian
gh secret set CLOUDFLARE_ACCOUNT_ID --repo schubydoo/claustodian
```

Manual deploys still work — `npx wrangler deploy` from `worker/` — but a dashboard
edit will be silently overwritten by the next push to `main` that touches
`worker/**`. The repo is the source of truth; nothing continuously detects drift
between pushes.

## Still open

- The Worker has no CI deploy. Adding one needs a scoped API token in repo secrets.
- Domain verification **is** enabled (`protected_domain_state: verified`), which
  guards against takeover if Pages is ever disabled.
