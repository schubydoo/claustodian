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

## Use it with an AI agent

Point your agent at [`llms.txt`](llms.txt) (served at `https://schubydoo.github.io/claustodian/llms.txt`)
or the [agent guide in `examples/`](examples/README.md) to teach it how to consume this data and
make its features version-accurate. The `examples/` directory has runnable, dependency-light clients
you can copy — [`quickstart.sh`](examples/quickstart.sh) (curl + jq),
[`claustodian.ts`](examples/claustodian.ts) (zero-dep TypeScript),
and [`claustodian.py`](examples/claustodian.py) (stdlib-only Python).

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

- **`changelog`** — extracted from the official `CHANGELOG.md`. Authoritative for existence.
- **`docs`** — from the official Claude Code documentation pages (`code.claude.com/docs`). Supplies the authoritative description and, where a page states a `min-version`, an anchored `first_seen`.
- **`binary`** — extracted from published release binaries by positive-evidence detection: CLI flags (commander registration or `process.argv` checks), environment variables (`process.env` access), and **built-in commands from the bundled command registry**. Every binary find starts as `status: needs_review` until a human confirms it; `first_seen` (and a conservative, cliff-aware `removed_in`) come from the versions it was actually observed in.

`first_seen_estimated: true` flags records whose `first_seen` is an upper bound (an incidental changelog mention or a docs page with no `min-version`); those carry `confidence: medium` until the binary lane confirms them.

> **Coverage limitation — commands.** The binary lane sees only Claude Code's **built-in** command registry. **Skill- and plugin-provided slash-commands (e.g. `/schedule`, `/loop`) are not captured** — they are registered through a separate mechanism the extractor does not scan. A skill-command's absence from the dataset is **not** evidence it never existed. (Roadmap item — see Status.)

**Claustodian uses only material Anthropic has publicly published and distributed** — the changelog, the official docs pages, and official release binaries. It does not use leaked or otherwise non-public material. See CONTRIBUTING.

## Status

Three lanes feed the dataset today:

- **changelog lane** — schema + validator, the changelog scraper, and Pages publishing.
- **docs lane** — official docs descriptions and anchored `first_seen` from `min-version` annotations.
- **binary lane** — undocumented-symbol coverage from release binaries (flags, env vars, built-in commands), plus `first_seen` corrections and conservative cliff-aware removal detection. Binary finds ship as `status: needs_review`.

### Roadmap / backlog

- **Extract skill- and plugin-provided commands** (e.g. `/schedule`, `/loop`) — currently missed because the binary lane only reads the built-in command registry. Evaluate parsing skill/plugin command manifests in a future release.
- Teach the extractor **subcommand flags** and **commander built-ins** (`--help`, `--version`).
- Fix the **~2.1.160 extraction-recall regression** to tighten late-era per-version accuracy.
- Detect explicit **changelog removals** so `removed_in` can be set on confirmed (changelog/docs) symbols, not just binary-only ones.

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
