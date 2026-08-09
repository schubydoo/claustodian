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

## 2026-08-08

### Added

- **`og-image.png`** at the site root, plus Open Graph and Twitter card meta on the
  site. Links to <https://claustodian.dev> now render a preview card.
- **`category: "cli-internal"`** on `cli_flag` records. Marks a flag hidden from
  `claude --help` — it works and the CLI accepts it, but something else sets it (a
  spawning parent, an orchestrator, a deep link), so passing it yourself usually does
  nothing. `category: "cli"` flags are the user-facing ones. Derived from commander's
  `.hideHelp()`.
- **`category: "global-config"`** on `config_key` records. These keys belong in
  `~/.claude.json` and are **silently ignored** if written to `settings.json` — a
  distinction the dataset previously could not express.
- **`description_source: "help"`** as a value, for descriptions taken from
  first-party CLI help output.

### Changed

- Settings keys from the official `settings.md` docs page now join the docs lane, so
  many `config_key` records gained authoritative descriptions.
- A parent settings object no longer inherits its first child's description. Eight of
  twenty parents had been publishing a child's sentence.

## 2026-08-07

### Added

- **`scopes`** (optional, `cli_flag` only) — the complete list of **full invocation
  paths** a flag is accepted under, e.g. `["remote-control"]` or `["plugin eval"]`.
  Present means the flag is **not** accepted on bare `claude`, and a multi-word path
  means it is not accepted on the parent either: both `claude --sandbox` and
  `claude plugin --scaffold` fail. **Absent does not mean top-level** — it means no
  scope information was recorded, which is true of most of the dataset.
- **`type: "config_key"`** records — `settings.json` keys read out of the schema
  Claude Code embeds, with `category: "settings"` or `"settings-internal"` (the
  latter marked `@internal` upstream).

### Changed

- The base URL moved to **<https://claustodian.dev>**. The old
  `https://schubydoo.github.io/claustodian` base 301-redirects there with the path
  preserved, so any client that follows redirects keeps working. A bare `curl`
  without `-L` gets the redirect page instead of JSON.

## 2026-07-14

### Added

- **`data/catalog.json`** — one entry per `(type, symbol)` **ever** observed,
  including removed symbols, with the full lifecycle. Per-version snapshots contain
  only what was live at that version, so this is the only file that can answer "did X
  ever exist?".

  Note it is the one file with no `.yaml`/`.toml` sibling: it is built after the
  export step runs.

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
