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

## 2026-09-04

### Fixed

- **Settings keys resolve inside their own module from 2.1.242 on.** The binary
  settings lane walks the embedded zod schema. It follows each sub-schema reference
  to its definition by minified name. Since the 2.1.242 code-split, every chunk
  minifies its own names. The lane still searched the flat concatenation, so a
  reference sometimes landed on an unrelated object in another chunk. Every dataset
  regenerated since then carried phantom `config_key` records built that way, for
  example `hooks.session_id` (2.1.242), `cleanupPeriodDays.permission_policy`
  (2.1.246), `viewMode.tier` and `permissions.args.event_props.*` (2.1.248),
  `policyHelper.name` (2.1.251), `theme.event_type` (2.1.257) and
  `modelSettings.agentId` (2.1.260). The same mis-resolution dropped
  `permissions.allow`, `deny`, `ask`, `defaultMode`, `disableBypassPermissionsMode`
  and `additionalDirectories` from every snapshot between 2.1.242 and 2.1.256. The
  lane now takes the chunk list and walks the schema in the chunk that declares it.
  An imported name resolves in the module that exports it, matched by the
  module-identity fingerprint the control lane already uses. Output before 2.1.242
  is unchanged. **No data ships in this change.** The regeneration that removes the
  phantoms and restores the six `permissions.*` keys is a separate data PR.

## 2026-08-28

### Fixed

- **Three commander flags promoted from `needs_review` to `active`.** The 2.1.251
  `--help` walk confirmed `--mocks` (`plugin eval`), `--post` and `--no-post`
  (`ultrareview`) as genuine, user-facing flags carrying their own first-party
  descriptions, so they join `PROMOTED_BINARY_SYMBOLS` — `status: "active"`,
  `confidence: "high"`, `description_source: "help"`. `--eval-dir` was left
  `needs_review`: it names a different directory under `plugin eval` (the eval-cases
  dir to run) than under `plugin eval init` (the dir to write cases into), and one
  `type:symbol` record cannot hold both — the same bar `--api-url` is held to.

- **Five commander-flag scopes a fresh `--help` walk found.** The curated scope table
  was captured at 2.1.226; a full `claude <path> --help` walk ~25 releases later
  surfaced commander flags whose scope only help can resolve (the binary lanes see
  hand-rolled parsers, not commander registrations). `--eval-dir` (`plugin eval` and
  `plugin eval init`), `--mocks` (`plugin eval`), and `--post` / `--no-post`
  (`ultrareview`) gained scopes, and `--yes` gained `plugin install` / `plugin update`.
  Each was a false "no" — a consumer asking "is `--post` accepted under `ultrareview`?"
  now gets yes. `--remote` was deliberately left unscoped despite appearing under
  `plugin tag --help`: it is a hidden top-level flag (a deprecated `--cloud` alias), so
  scoping it would falsely claim `claude --remote` is rejected.

- **Dropped six non–Claude Code env vars the changelog lane pulled from prose.** The
  changelog names external-tool, shell, and OS variables incidentally in backticks,
  and the broad `env_var` pattern seeded them as symbols: `GH_TOKEN` / `GITHUB_TOKEN`
  (the `gh` CLI / GitHub Actions auth convention), `OPTIND` / `RANDOM` (bash builtins
  shown only as arithmetic-assignment examples in a permission-check bugfix), and
  `TMPDIR` / `TEMP` (OS temp-dir vars a bullet says Claude Code no longer sets). They
  now join the changelog-lane denylist alongside `PATH`/`HOME`/`GIT_DIR`. Consumers
  filtering `type: "env_var"` no longer see these six; the binary lane still observes
  them raw and withholds them at publication, so no genuine Claude Code var is lost.

- **`--all` now records `respawn` among its scopes.** `claude respawn <id>|--all`
  accepts `--all`, but the background-session subcommands are hand-rolled parsers the
  binary scope lane could not read — they string-compare the argument instead of
  using `case"--flag":` labels, and since 2.1.242 sit outside the modules that lane
  partitions on. A new `extractBgSubcommandScopes` reads them (the guard rejecting
  every other dash-led token is the complete accepted set), and `respawn` joins
  `--all`'s curated scopes. A consumer asking "is `--all` accepted under `respawn`?"
  now gets yes instead of a false no.

- **Subcommand `scopes` restored for the code-split era (2.1.242+).** The binary scope
  lane containment keyed on esbuild namespace-module headers, which the 2.1.242 Bun
  ESM code-split removed — each subcommand parser became its own `// @bun @bytecode`
  chunk — so the lane returned nothing from 2.1.242 on, and the ~47 `self-hosted-runner`
  flags kept their scopes only through `binary-observations` persisting the last
  pre-split reading. The lane now partitions by chunk (a header-less chunk is itself
  one module), mirroring the control lane's 2.1.242 fix. Pre-split output is
  unchanged; from 2.1.242 the scopes are read live again, so a switch-case flag first
  seen in the split era — previously withheld for want of a complete scope — now
  publishes with its owning subcommand.

## 2026-08-22

### Fixed

- **Settings keys keep their documented descriptions.** Anthropic split the settings
  page in two, moving every key definition to a settings reference page. The docs lane
  still read the original page, still parsed it, and found nothing there — so every
  documented `config_key` lost its first-party description and `source_url`, dropped
  from `provenance: "docs"` to `provenance: "binary"`, and fell back to
  `status: "needs_review"`. The lane now reads the reference page, and refuses to
  publish a run in which a page that should carry symbols stops yielding them.
  Consumers reading `config_key` descriptions or filtering on `status` see the
  documented surface restored, plus the keys the new page documents that the old one
  did not.

## 2026-08-15

### Added

- **`scope_descriptions` on `cli_flag` records — per-subcommand description
  overrides.** A flag whose official docs describe it differently under different
  subcommands now carries a `scope_descriptions` map: for example `--force` reads
  "Overwrite an existing `.claude-plugin/` at the target" under `plugin init` but
  "Create the tag even if the working tree is dirty or the tag already exists"
  under `plugin tag`. Keys are a subset of `scopes`; resolve a scope's text as
  `scope_descriptions[scope] ?? description`. A scope the docs do not describe
  separately (the flag's `install` scope, say) is absent rather than given a wrong
  description. Optional and additive — a consumer that ignores it still gets a
  correct primary `description`, so `schemaVersion` stays `1.0.0`.

## 2026-08-14

### Added

- **`control_message` records — the stream-json control protocol's request
  subtypes.** Each is extracted from the release binary's own schema declarations, so
  every snapshot from the protocol's floor onward now carries the subtypes live at that
  version. They add two fields that appear on no other type and are required here:
  `family` (currently always `control_request`) and `direction`
  (`host_to_cli`, `cli_to_host`, or `null`). A `direction` of `null` means the CLI had
  not yet declared the message's direction at that version — it is a value, not a
  missing field.
- **A security contact at <https://claustodian.dev/.well-known/security.txt>.** An
  RFC 9116 file pointing at the private reporting channels already named in
  `SECURITY.md`. Adds no data of its own. (#233)

### Changed

- **`confidence: "low"` is now a value you can observe.** It marks a control subtype
  the binary only ever _dispatches_ — the CLI handles the message, but no schema in the
  bundle describes it. Every other lane grades `high` or `medium`.
- **A `provenance: "binary"` record can now carry `status: "active"`.** Until now every
  binary-sourced record stayed `needs_review` until a human confirmed it.
  `control_message` records are exempt: the lane reads the subtype's name off the CLI's
  own declaration rather than inferring it from free text, so existence is established
  by the artifact.
- **Read `first_seen_estimated`, not `confidence`, to tell whether a date is exact.**
  On other lanes `confidence: medium` travels with an estimated `first_seen`; on
  `control_message` records confidence grades evidence strength instead, so a `low`
  record can still be exactly dated.

### Removed

- **The OS/shell environment variables `PATH`, `HOME`, `LANG`, `COLUMNS`, `LINES`,
  `OLDPWD`, `DIRSTACK`, and `XDG_DATA_HOME` are no longer published.** The changelog
  lane seeded them from incidental prose — a bullet mentioning a stale `PATH` was
  enough — but Claude Code reads these without owning them; they belong to the OS and
  shell. The variables it genuinely honors (`NO_COLOR`, `FORCE_COLOR`) and the
  OpenTelemetry context it propagates (`TRACEPARENT`, `TRACESTATE`) are unaffected.

### Fixed

- **A documentation description no longer backfills onto older snapshots.**
  `data/docs.json` is one capture of the current documentation. There is no
  per-version documentation history, so a docs-sourced description is evidence
  about the tip and nothing else. Every historical snapshot published it anyway.
  The result was text that refutes itself: `data/versions/2.1.200.json` described
  `/review` as "Alias of `/code-review` … **Before v2.1.223**, `/review` was a
  separate command." Every snapshot from 2.1.186 on carried that sentence.

  The resolver kept a description when the binary help text had not changed since
  that version. That test was a proxy for whether the docs text still applied, and
  it is not a sound one. `/review`'s binary text is unchanged since 2.1.186, while
  its docs text describes behavior that began at 2.1.223.

  A description is now refused at a version when its own text names either a
  release later than that version, or a backticked symbol — of any of the four
  types this dataset publishes, where the span holds that symbol alone — whose
  `first_seen` is later than that version. The check is self-consistency against
  the dataset, not a judgement about prose. A symbol the dataset does not know is
  ignored, because absence of a record is not evidence that the symbol did not
  exist.

  When the binary observed the symbol at that version, its text replaces the docs
  text and `description_source` becomes `binary`. `/cost` at 0.2.21 becomes "Show
  the total cost and duration of the current session" instead of "Alias for
  `/usage`", a command that did not exist until 2.0.0.

  Otherwise the description keeps the leading sentences that name nothing later
  than the version. These descriptions are an era-correct opening plus sentences
  appended as behavior grew, so truncation preserves correct text that a blanket
  removal would discard.

  A description becomes empty when the binary lane has no text to fall back on and
  either of two things is true. Its first sentence already names something later —
  `MCP_OAUTH_CALLBACK_PORT` is blank before 2.1.30, the release that introduced the
  `--callback-port` its only sentence points at. Or the sentence that trips the
  guard is _correcting_ the ones before it, in which case the prefix cannot be
  published either.

  That second case empties records whose opening sentence reads fine.
  `ENABLE_TOOL_SEARCH` has eight sentences and only the last is a "Before v2.1.221"
  correction, yet the whole record is blank below that release. A correction is
  known to invalidate something earlier, and sentence granularity cannot say which,
  so the honest answer is to publish none of it rather than guess which half
  survived. The binary lane does not record env var help text, which is why these
  cases are env vars.

  Nothing changes at the newest version. The guard skips that snapshot outright
  rather than relying on no release comparing greater — a release can be known to
  the binary lane before the changelog has a heading for it, so that property was
  never guaranteed by the data.

---

## 2026-08-13

### Fixed

- **Four `scopes` lists said a flag was invalid where it is accepted.** `scopes` is
  the COMPLETE set of subcommands a flag works under, so a non-empty list also
  asserts "not accepted on bare `claude`" — which makes an incomplete list a false
  no, not merely a partial yes. Two independent holes in the curated sweep produced
  four of them.

  The sweep stopped at depth two, so it never read the five depth-three invocations
  `claude` accepts at 2.1.226 — `plugin eval init` and
  `plugin marketplace {add,list,remove,update}`:

  | flag            | was                    | now                                                |
  | --------------- | ---------------------- | -------------------------------------------------- |
  | `--interactive` | `project purge`        | + `plugin eval init`                               |
  | `--json`        | 5 invocations          | + `plugin marketplace list`                        |
  | `--scope`       | 10 invocations         | + `plugin marketplace add`, `… marketplace remove` |
  | `--sparse`      | _(no scopes recorded)_ | `plugin marketplace add`                           |

  Separately, `--remote` published as `["plugin tag"]` and so claimed
  `claude --remote` is invalid. It is not: `--remote` is a hidden top-level
  deprecated alias for `--cloud`, documented that way on the official CLI reference
  page and handled in the 2.1.226 bundle's top-level argv. Being hidden is exactly
  why the sweep mis-scoped it — the rule excludes what bare `claude --help` accepts,
  and a hidden flag never appears there. **`--remote` now carries no `scopes` at
  all**, which reads as "no scope information" rather than a false restriction.

### Added

- **`--interview` is scoped to `plugin eval init`.** Hidden on the subcommand it
  belongs to, so the help sweep missed it, but nothing false had shipped — it simply
  had no scope before.

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
