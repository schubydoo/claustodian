# Claustodian

[![Validate PR](https://github.com/schubydoo/claustodian/actions/workflows/validate-pr.yml/badge.svg)](https://github.com/schubydoo/claustodian/actions/workflows/validate-pr.yml)
[![Security](https://github.com/schubydoo/claustodian/actions/workflows/security.yml/badge.svg)](https://github.com/schubydoo/claustodian/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/schubydoo/claustodian/badge)](https://scorecard.dev/viewer/?uri=github.com/schubydoo/claustodian)
[![Code: Apache-2.0](https://img.shields.io/badge/code-Apache--2.0-blue.svg)](LICENSE)
[![Data: CC BY 4.0](https://img.shields.io/badge/data-CC--BY--4.0-blue.svg)](LICENSE-DATA)

A static, versioned, machine-parseable record of every Claude Code CLI flag, environment variable, command, and config key — each tagged with the version it **first appeared** in (and, when known, when it was removed). Answer _"does feature X exist in Claude Code version Y?"_ by fetching a file, in any language, with no scraping.

## Why

Claude Code ships multiple releases a week and there's no machine-queryable record of when each part of its surface appeared or disappeared. Claustodian is that record: JSON as the single source of truth, published as static files (JSON + generated YAML + TOML) on GitHub Pages.

## Quick start

Every version is a static file. To check whether a symbol exists in a version:

```bash
# What does the latest snapshot say about --safe-mode?
curl -s https://schubydoo.github.io/claustodian/data/latest.json \
  | jq '.symbols[] | select(.symbol == "--safe-mode") | {first_seen, removed_in, status}'

# Is CLAUDE_CODE_SAFE_MODE present in 2.1.169?  (exit code: 0 = yes, 1 = no)
curl -s https://schubydoo.github.io/claustodian/data/versions/2.1.169.json \
  | jq -e '.symbols[] | select(.symbol == "CLAUDE_CODE_SAFE_MODE")' > /dev/null \
  && echo "available" || echo "not available"
```

A symbol is available in version Y when `first_seen <= Y` and (`removed_in` is null or `> Y`).

## Data layout

Stable, predictable URLs under `data/`:

| Path                       | What                                              |
| -------------------------- | ------------------------------------------------- |
| `data/latest.json`         | Full symbol list as of the newest tracked version |
| `data/versions/X.Y.Z.json` | Full symbol list as of version X.Y.Z              |
| `data/index.json`          | All tracked versions + the latest                 |
| `data/schema-version.json` | Version of this data format                       |

Each file is also published as `.yaml` and `.toml` (generated in CI from the JSON; JSON is the source of truth). Each record follows [`schema/symbol.schema.json`](schema/symbol.schema.json) (JSON Schema draft 2020-12):

```json
{
  "symbol": "--safe-mode",
  "type": "cli_flag",
  "first_seen": "2.1.169",
  "removed_in": null,
  "status": "active",
  "provenance": "changelog",
  "confidence": "high",
  "description": "Starts Claude Code with all customizations disabled, for troubleshooting.",
  "source_url": "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  "category": "startup"
}
```

## Important: what `first_seen` means

`first_seen` is the **earliest version in which Claustodian observed a symbol — not a guarantee of the first version it truly existed in.** Changelog-sourced entries are bounded by when the changelog first mentioned the symbol; binary-sourced entries by the earliest release we extracted. Treat it as a lower bound on availability, not an absolute origin.

## Provenance & trust

Every record carries a `provenance`:

- **`changelog`** — extracted from the official `CHANGELOG.md`. Authoritative; always `confidence: high`.
- **`binary`** — extracted from published release binaries (a later phase). Starts as `status: needs_review` until a human confirms it.

**Claustodian uses only material Anthropic has publicly published and distributed** — the changelog and official release binaries. It does not use leaked or otherwise non-public material. See CONTRIBUTING.

## Status

v1.0 covers the **changelog lane**: the schema + validator, the changelog scraper, and Pages publishing. Undocumented-symbol coverage (binary extraction) and a self-extracted historical backlog are planned follow-ups.

## Development

```bash
npm ci
npm test          # unit tests
npm run validate  # validate all data/ files against the schema
npm run scrape -- --all   # (re)generate the full dataset from the changelog
```

## License

Dual-licensed:

- **Code** (scripts, schema, config) — **Apache-2.0** (see `LICENSE`). Requires preserving attribution/notices; includes a patent grant.
- **Data** (everything under `data/`) — **CC-BY-4.0** (see `LICENSE-DATA`). Use it however you like, including commercially — just credit Claustodian, e.g. _Data from Claustodian (https://github.com/schubydoo/claustodian), © 2026 Schuby, CC-BY-4.0._
