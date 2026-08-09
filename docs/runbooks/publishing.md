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
   `og-image.png`, `llms.txt`
5. Deploys via `actions/deploy-pages` using OIDC — no stored credential

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
| `www` does not resolve                          | No `www` CNAME record exists; the apex is the only hostname.       |

## Still open

- `www.claustodian.dev` has no DNS record. The apex is the only hostname.

Domain verification **is** enabled (`protected_domain_state: verified`), which guards
against takeover if Pages is ever disabled.
