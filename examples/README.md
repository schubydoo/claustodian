<!--
Copyright 2026 Schuby
SPDX-License-Identifier: CC-BY-4.0
-->

# Building on Claustodian — agent guide

Point your agent at this file (or at [`/llms.txt`](../llms.txt)) to teach it how to
consume Claustodian's published data and make its features **version-accurate** for a
specific user's Claude Code version.

Claustodian answers one question:

> Does a Claude Code **symbol** — a CLI flag, environment variable, or slash command —
> exist in a specific **version**, and what did it do at that version?

The data is static JSON on GitHub Pages (also YAML/TOML). There's nothing to install:
fetch a URL and read it. Three tiny reference clients live next to this file:

| File | Runtime | Run it |
| --- | --- | --- |
| [`quickstart.sh`](quickstart.sh) | curl + jq | `bash examples/quickstart.sh` |
| [`claustodian.ts`](claustodian.ts) | Node 18+ (zero deps) | `npx tsx examples/claustodian.ts` |
| [`claustodian.py`](claustodian.py) | Python 3.9+ (stdlib) | `python3 examples/claustodian.py` |

All three implement the same three rules below.

## Endpoints

Base URL: **`https://schubydoo.github.io/claustodian/data`**
(raw-file fallback: `https://raw.githubusercontent.com/schubydoo/claustodian/main/data`)

| Path | Contents |
| --- | --- |
| `index.json` | `{ schemaVersion, latest, versions[] }` — every tracked version (newest-first) |
| `latest.json` | Full symbol snapshot for the newest tracked version |
| `versions/<X.Y.Z>.json` | Full symbol snapshot **as of that version** — the ground truth for it |
| `schema-version.json` | `{ "version": "1.0.0" }` — a bump signals a format change |
| `binary-descriptions.json` | Per-symbol **description timeline** (change-point eras) |
| `binary-observations.json` | Raw binary-lane first/last-seen observations (provenance detail) |
| `docs.json` | Symbols/descriptions harvested from the official docs |

Core files are also published as `.yaml` and `.toml` (swap the extension); **JSON is the
source of truth**, and the newest few per-version files plus the `binary-*` files may be
JSON-only — prefer `.json`. Published `versions/<X.Y.Z>.json` files are effectively
immutable, so cache them hard by version.

## The record schema

A snapshot is `{ claudeCodeVersion, schemaVersion, symbols: [...] }`. Each symbol
(validated against [`schema/symbol.schema.json`](../schema/symbol.schema.json)):

```json
{
  "symbol": "--output-format",
  "type": "cli_flag",            // "cli_flag" | "command" | "env_var"
  "first_seen": "1.0.19",        // earliest version OBSERVED (semver string)
  "removed_in": null,            // version it vanished, or null if still present
  "deprecated_in": "2.1.73",     // OPTIONAL: version it was marked deprecated
  "status": "active",            // "active" | "deprecated" | "needs_review"
  "provenance": "changelog",     // "changelog" | "docs" | "binary" — which lane proved existence
  "confidence": "high",          // "high" | "medium"
  "first_seen_estimated": true,  // OPTIONAL: first_seen is an UPPER BOUND, not exact
  "description": "Output format…",
  "description_source": "docs",  // OPTIONAL: "docs" | "changelog" | "binary" | "help"
  "source_url": "https://…",     // citation, or null
  "category": "cli"
}
```

## The three rules

**1. Availability.** A symbol is available in version `Y` when
`first_seen <= Y AND (removed_in is null OR removed_in > Y)`, using **semver** ordering
(`2.1.9 < 2.1.10`). Simplest of all: fetch `versions/<Y>.json` and test whether the
symbol is present — that snapshot already encodes availability for that version.

**2. Removal = vanish.** A removed symbol is *absent* from snapshots at and after
`removed_in`. In the last snapshot where it still exists, its record carries
`removed_in: "<next version>"`. Detect removal from that field, not from absence alone.

**3. Deprecation = status flip.** A deprecated symbol stays *present* but flips `status`
to `"deprecated"` at `deprecated_in`. It may later be removed too — the states compose
(active → deprecated → absent).

## Trust tiers

- `provenance: docs`/`changelog` + `confidence: high` → authoritative for existence and description.
- `status: needs_review` → the symbol **provably exists** (seen in a release binary) but isn't
  human-curated; description may be terse or empty. Treat it as real, not "maybe."
- `first_seen_estimated: true` (or `confidence: medium`) → `first_seen` is an **upper bound**;
  don't claim "introduced exactly in X."
- `source_url: null` is normal for binary-only symbols.

## Description-at-version

Each snapshot's `description` is already the text as of that version where known. For a
symbol's full history, read `binary-descriptions.json`: keys are `"<type>:<symbol>"`
(e.g. `cli_flag:--add-dir`, `command:/init`) and values are eras
`[{ "from": "1.0.18", "description": "…" }, …]`. To get the text at version `Y`, take the
last era whose `from <= Y`. Env vars generally have no timeline yet.

## Gotchas

- **Not every version is tracked** — check `index.json.versions` first; a 404 on
  `versions/<X>.json` means untracked, not "symbol absent." Fall back to the nearest
  tracked version `<= Y`.
- **`needs_review` ≠ nonexistent.** Surface it; don't filter it out.
- **Compare versions as semver**, never as strings.
- **Verify `schemaVersion`** is the `1.x` you built against before trusting field names.
