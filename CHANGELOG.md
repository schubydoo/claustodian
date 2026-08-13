# Changelog

Changes to the **data contract** — the things a consumer can observe. New or changed
fields, new endpoints, changed semantics, and `schemaVersion` bumps.

This is not a changelog of the pipeline. Refactors, tests and extractor internals are
in `git log`; they only appear here when they change what you can read out of the
published files.

There are no releases or tags: the dataset is regenerated continuously and published
on every push to `main`, so entries are dated rather than versioned.

**Additive changes do not bump `schemaVersion`.** A new optional field cannot break a
consumer that ignores it, so the version stays `1.0.0` and the change is recorded
here instead. Check this file, not `schema-version.json`, to find out what is new.

---

## 2026-08-12

### Fixed

- **A slash command's bracketed arguments no longer publish as top-level CLI
  flags.** The docs parser read a table's first cell by scanning for a `--flag`
  before testing the slash-command anchor. The commands page writes a command's
  arguments inside the same backtick span, so three rows resolved to their
  argument instead of their command:

  | cell                                                | was                    | now                         |
  | --------------------------------------------------- | ---------------------- | --------------------------- |
  | `` `/reload-plugins [--force]` ``                   | `cli_flag` `--force`   | `command` `/reload-plugins` |
  | `` `/code-review … [--fix] …` ``                    | `cli_flag` `--fix`     | `command` `/code-review`    |
  | `` `/review … [--fix] …` ``                         | `cli_flag` `--fix`     | `command` `/review`         |
  | `` `/import [codex\|gemini] [--dry-run] [--yes]` `` | `cli_flag` `--dry-run` | `command` `/import`         |

  Each cost the dataset twice. The command was lost from the docs lane, and the
  argument was published as a `claude` CLI flag carrying the _command's_
  description — `--force` shipped as "Reload all active plugins to apply pending
  changes without restarting", which describes `/reload-plugins`.

  `--fix` had no evidence in any other lane and is removed. `--force` and
  `--dry-run` are real flags the binary lane observes independently; they keep
  their records and pick up correct descriptions. `/code-review`, `/import`,
  `/reload-plugins` and `/review` gain their documented descriptions.
- **Six subprocess flags no longer publish as Claude Code CLI flags.** The changelog
  lane suppresses a subprocess tool's own flags when a bullet lists them as examples,
  but the rule only recognised an `(e.g., …)` lead-in. Two bullets write the example
  list as a bare parenthetical opening straight off the word "flags", and both leaked:

  - 2.1.214 — "`docker` commands … carrying daemon-redirect flags (`--url`,
    `--connection`, `--identity`, …)" published `--url`, `--connection` and
    `--identity` as `cli_flag` records with `confidence: "high"` and no evidence in
    any other lane. They are removed from every snapshot from 2.1.214 on.
  - 2.1.229 — "`/commit-push-pr` so git/gh commands with dangerous flags (`--force`,
    `--amend`, `--no-verify`, etc.)" would have added `--amend`, moved `--no-verify`
    from `provenance: "binary"` / `first_seen: "2.1.224"` to `provenance: "changelog"`
    / `first_seen: "2.1.229"` (dropping its help description), and flipped `--force`
    from `provenance: "docs"` to `provenance: "changelog"`. None of that now happens.

  The rule still requires a subprocess tool name, the word "flags", and at least one
  flag token inside the clause, so a bullet introducing a genuine first-party flag is
  untouched.

---

## 2026-08-09

### Added

- **A `control_message` symbol type in the schema, for the stream-json control
  protocol.** Claustodian already tracks the transport for that channel
  (`--input-format`, `--output-format`, `--replay-user-messages` and friends); this
  adds the vocabulary that travels inside it — the `control_request` subtypes a host
  application must implement to drive the CLI, such as `initialize`,
  `set_permission_mode`, `hook_callback` and `remote_control`. Records carry two new
  fields: `family` (currently always `control_request`) and `direction`
  (`host_to_cli`, `cli_to_host`, or `null`).

  **`direction: null` means "not observable for this record", not "this version
  predates the split".** It arises two ways. The CLI began declaring the two
  directions as separate schema unions at 2.1.133, so every record in an older
  snapshot has null; but a subtype evidenced only by a call site or a dispatch
  belongs to no directional union at _any_ version, so it is null there too — in the
  2.1.226 snapshot that includes `remote_control`, alongside sibling records that
  carry a direction. Null is never backfilled from a later release. Descriptions are
  likewise absent before 2.1.63.

  **No data ships in this change** — the schema accepts these records, and nothing
  emits them yet. Additive, so `schemaVersion` stays `1.0.0`.

- **An MCP endpoint at <https://claustodian.dev/mcp>.** The same records, queryable
  over Model Context Protocol instead of by fetching and filtering a snapshot
  yourself: `list_versions`, `get_symbol` (does this flag / command / settings key /
  env var exist at version X, with its full record) and `search_symbols`. Speaks MCP
  revision `2026-07-28` — the per-request-metadata one, with no `initialize`
  handshake and no sessions. **No new data and no schema change**: every answer comes
  from the published `data/` files, and the JSON endpoints remain the source of
  truth. There is deliberately no "did this ever exist" tool, because that question
  needs `catalog.json`, whose parse alone exceeds the endpoint's CPU budget — use
  `catalog.json` directly for it. (#176)
- **A discovery catalogue at <https://claustodian.dev/.well-known/api-catalog>.** An
  RFC 9727 linkset pointing at the existing data endpoints, `llms.txt` and the record
  schema, so an agent can find them from a fixed path without knowing about
  `llms.txt` first. Adds no data of its own. (#171)

## 2026-08-08

### Added

- **`category: "cli-internal"`** on `cli_flag` records. Marks a flag hidden from
  `claude --help` — it works and the CLI accepts it, but something else sets it (a
  spawning parent, an orchestrator, a deep link), so passing it yourself usually does
  nothing. `category: "cli"` flags are the user-facing ones. Derived from commander's
  `.hideHelp()`. (#153)
- **`category: "global-config"`** on `config_key` records. These keys belong in
  `~/.claude.json` and are **silently ignored** if written to `settings.json` — a
  distinction the dataset previously could not express. (#145)

### Changed

- **The published base URL moved to <https://claustodian.dev>.** The old
  `https://schubydoo.github.io/claustodian` base 301-redirects there with the path
  preserved, so any client that follows redirects keeps working. A bare `curl` without
  `-L` gets the redirect page instead of JSON. (#154)
- Settings keys from the official `settings.md` docs page joined the docs lane, so
  many `config_key` records gained authoritative descriptions. (#143)
- A parent settings object no longer inherits its first child's description. Eight of
  twenty parents had been publishing a child's sentence. (#147)
- 39 more flags gained `description_source: "help"` descriptions verified against
  first-party CLI help output. (#139)

## 2026-08-07

### Added

- **`scopes`** (optional, `cli_flag` only) — the complete list of **full invocation
  paths** a flag is accepted under, e.g. `["remote-control"]` or `["plugin eval"]`.
  Present means the flag is **not** accepted on bare `claude`, and a multi-word path
  means it is not accepted on the parent either: both `claude --sandbox` and
  `claude plugin --scaffold` fail. **Absent does not mean top-level** — it means no
  scope information was recorded, which is true of most of the dataset. (#133)
- **First `type: "config_key"` records** — `settings.json` keys read out of the schema
  Claude Code embeds, with `category: "settings"` or `"settings-internal"` (the latter
  marked `@internal` upstream). The type had been in the schema enum since the start;
  this is when records began appearing. (#129)

## 2026-07-14

### Added

- **`data/catalog.json`** — one entry per `(type, symbol)` **ever** observed,
  including removed symbols, with the full lifecycle. Per-version snapshots contain
  only what was live at that version, so this is the only file that can answer "did X
  ever exist?". (#67)

  It is the one published file with no `.yaml`/`.toml` sibling: it is built after the
  export step runs.

## 2026-07-09

### Added

- **`deprecated_in`** (optional) — the version a symbol was marked deprecated. The
  symbol stays present and its `status` flips to `"deprecated"`; it may be removed
  later, so the states compose. (#41)
- **`data/binary-descriptions.json`** — per-symbol description timeline, keyed
  `"<type>:<symbol>"`, as change-point eras. Take the last era whose `from <= Y` for
  the text at version Y. (#43)
- **`description_source`** gained `"binary"` and `"help"`, alongside the existing
  `"docs"` and `"changelog"`. (#39)

## 2026-07-06

### Added

- **`data/binary-observations.json`** — raw binary-lane first/last-seen observations.
  Provenance detail rather than a consumer endpoint, but it is published. (#28)

## 2026-07-05

### Added

- **`provenance: "docs"`**, plus **`description_source`** and
  **`first_seen_estimated`**. `first_seen_estimated: true` marks a `first_seen` that
  is an **upper** bound — an incidental changelog mention, or a docs page with no
  stated `min-version` — so the true version may be earlier. Those records carry
  `confidence: "medium"`. (#18)
- **`data/docs.json`** — symbols and descriptions harvested from the official docs
  pages. (#18)

### Removed

- **`platforms`** — dropped before v1.0. It was never populated, so nothing could
  have depended on it.

---

## Notes for consumers

- **Snapshots are not immutable.** A published `versions/<X.Y.Z>.json` is regenerated
  whenever a lane finds new evidence, including for long-past releases. Records gain
  descriptions, `first_seen` gets sharpened, and symbols are _added_ — so absence from
  an old snapshot is provisional. Revalidate rather than pinning.
- **`first_seen` is a lower bound** — the earliest version Claustodian observed a
  symbol, not proof of when it appeared. `first_seen_estimated: true` marks the ones
  that are an _upper_ bound instead.
- Field-level detail lives in [`schema/symbol.schema.json`](schema/symbol.schema.json)
  and the [agent guide](examples/README.md).
