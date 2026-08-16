<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/logo-white.svg" />
    <img src="assets/logo/logo-full.svg" alt="Claustodian" width="320" />
  </picture>
</p>

# Claustodian

[![Validate PR](https://github.com/schubydoo/claustodian/actions/workflows/validate-pr.yml/badge.svg)](https://github.com/schubydoo/claustodian/actions/workflows/validate-pr.yml)
[![Security](https://github.com/schubydoo/claustodian/actions/workflows/security.yml/badge.svg)](https://github.com/schubydoo/claustodian/actions/workflows/security.yml)
[![codecov](https://codecov.io/gh/schubydoo/claustodian/branch/main/graph/badge.svg)](https://codecov.io/gh/schubydoo/claustodian)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/schubydoo/claustodian/badge)](https://scorecard.dev/viewer/?uri=github.com/schubydoo/claustodian)
[![Code: Apache-2.0](https://img.shields.io/badge/code-Apache--2.0-blue.svg)](LICENSE)
[![Data: CC BY 4.0](https://img.shields.io/badge/data-CC--BY--4.0-blue.svg)](LICENSE-DATA)

A static, versioned, machine-parseable record of every Claude Code CLI flag, environment variable, command, config key, and stream-json control message — each tagged with the version it **first appeared** in (and, when known, when it was removed). Answer _"does feature X exist in Claude Code version Y?"_ by fetching a file, in any language, with no scraping.

## Why

Claude Code ships multiple releases a week and there's no machine-queryable record of when each part of its surface appeared or disappeared. Claustodian is that record: JSON as the single source of truth, published as static files (JSON + generated YAML + TOML) on GitHub Pages.

## Quick start

Every version is a static file. To check whether a symbol exists in a version:

```bash
# What does the latest snapshot say about --safe-mode?
curl -fsSL https://claustodian.dev/data/latest.json \
  | jq '.symbols[] | select(.symbol == "--safe-mode") | {first_seen, removed_in, status}'

# Is CLAUDE_CODE_SAFE_MODE present in 2.1.169?  (exit code: 0 = yes, 1 = no)
curl -fsSL https://claustodian.dev/data/versions/2.1.169.json \
  | jq -e '.symbols[] | select(.symbol == "CLAUDE_CODE_SAFE_MODE")' > /dev/null \
  && echo "available" || echo "not available"
```

A symbol is available in version Y when `first_seen <= Y` and (`removed_in` is null or `> Y`).

## Use it with an AI agent

Point your agent at [`llms.txt`](llms.txt) (served at `https://claustodian.dev/llms.txt`)
or the [agent guide in `examples/`](examples/README.md) to teach it how to consume this data and
make its features version-accurate. The `examples/` directory has runnable, dependency-light clients
you can copy — [`quickstart.sh`](examples/quickstart.sh) (curl + jq),
[`claustodian.ts`](examples/claustodian.ts) (zero-dep TypeScript),
and [`claustodian.py`](examples/claustodian.py) (stdlib-only Python).

## Data layout

Stable, predictable URLs under `data/`:

| Path                            | What                                              |
| ------------------------------- | ------------------------------------------------- |
| `data/latest.json`              | Full symbol list as of the newest tracked version |
| `data/versions/X.Y.Z.json`      | Full symbol list as of version X.Y.Z              |
| `data/index.json`               | All tracked versions + the latest                 |
| `data/catalog.json`             | Every symbol ever seen, incl. removed ones        |
| `data/docs.json`                | Symbols harvested from the official docs pages    |
| `data/binary-descriptions.json` | Per-symbol description timeline                   |
| `data/schema-version.json`      | Version of this data format                       |

Each file is also published as `.yaml` and `.toml` (generated in CI from the JSON; JSON is the source of truth) — except `catalog.json`, which is JSON-only because it is built after the export step runs. Each record follows [`schema/symbol.schema.json`](schema/symbol.schema.json) (JSON Schema draft 2020-12):

```json
{
  "symbol": "--safe-mode",
  "type": "cli_flag",
  "first_seen": "2.1.169",
  "removed_in": null,
  "status": "active",
  "provenance": "changelog",
  "confidence": "high",
  "description": "Start with all customizations disabled to troubleshoot a broken configuration…",
  "description_source": "docs",
  "source_url": "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  "category": "cli"
}
```

## Provenance & trust

`first_seen` is the **earliest version Claustodian observed a symbol — not proof of the version it truly appeared in.** Treat it as a lower bound. `first_seen_estimated: true` marks the ones that are an _upper_ bound instead (an incidental changelog mention, or a docs page with no `min-version`); those carry `confidence: medium` until the binary lane pins them. `control_message` grades `confidence` differently — read `first_seen_estimated` for the date, not `confidence`.

The binary lane also **creates** upper bounds, not only resolves them: a `control_message`
subtype can be invisible to extraction until its declaration becomes provable, so its `first_seen` is the
version it became visible, not the version it appeared.

Every record carries a `provenance`:

- **`changelog`** — the official `CHANGELOG.md`. Authoritative for existence.
- **`docs`** — the official documentation pages (`code.claude.com/docs`). Supplies the authoritative description and, where a page states a `min-version`, an anchored `first_seen`.
- **`binary`** — published release binaries, by positive-evidence detection: CLI flags (commander registration or `argv` checks), env vars (the typed registry), built-in _and_ skill/menu commands, and `settings.json` keys read out of the embedded schema. Binary flag, env-var, command and settings-key finds land as `status: needs_review` until a first-party description confirms them.

> **Coverage limitation — plugin commands.** Commands supplied by the **plugin/marketplace** subsystem register outside the CLI binary, so the binary lane cannot date them at all. Their absence is **not** evidence they never existed. Skill-provided commands (`/schedule`, `/loop`) _are_ captured.

**Claustodian uses only material Anthropic has publicly published and distributed.** It does not use leaked or otherwise non-public material. See CONTRIBUTING.

## Status

Three lanes feed the dataset today:

- **changelog lane** — schema + validator, the changelog scraper, and Pages publishing.
- **docs lane** — official docs descriptions and anchored `first_seen` from `min-version` annotations.
- **binary lane** — undocumented-symbol coverage from release binaries (flags, env vars, built-in commands, and `settings.json` keys read out of the embedded schema), plus `first_seen` corrections and conservative cliff-aware removal detection.

### Roadmap / backlog

- Teach the extractor **commander's built-in `--help`/`--version`**. They are auto-registered rather than declared, so the extractor misses them and their `first_seen` comes from a late changelog/docs mention (2.1.200 / 2.1.205) instead of 0.2.x.
- Parse explicit **changelog removal prose** to _propose_ `removed_in` on changelog- and docs-sourced symbols (today only the binary lane sets it) — surfaced for review, never auto-applied: a "Removed" bullet can retire a syntax form rather than the symbol (e.g. `DEBUG=true` was removed while `DEBUG` stays live).
- A site **"what changed in vX"** view — `catalog.json` already carries the full lifecycle.
- **Release dates** (`released_on`) from the docs changelog's `<Update>` annotations.

## Development

```bash
npm ci
npm test          # unit tests
npm run validate  # validate all data/ files against the schema
npm run scrape -- --all   # (re)generate the full dataset from the changelog
```

- [Architecture](docs/ARCHITECTURE.md) — the three lanes, the script map, and the
  invariants an extractor change has to hold.
- [Regenerating the dataset](docs/runbooks/regenerating-the-dataset.md) — the lane
  order and why it is not the obvious one, plus the reconciliation that has to happen
  first.
- [Publishing](docs/runbooks/publishing.md) — how the site deploys, and the
  custom-domain trap.

## License

Dual-licensed:

- **Code** (scripts, schema, config) — **Apache-2.0** (see `LICENSE`). Requires preserving attribution/notices; includes a patent grant.
- **Data** (everything under `data/`) — **CC-BY-4.0** (see `LICENSE-DATA`). Use it however you like, including commercially — just credit Claustodian, e.g. _Data from Claustodian (https://github.com/schubydoo/claustodian), © 2026 Schuby, CC-BY-4.0._
