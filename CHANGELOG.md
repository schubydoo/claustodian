# Changelog

Changes to the **data contract**, that is, the things a consumer can observe. New or
changed fields, new endpoints, changed semantics, and `schemaVersion` bumps.

This is not a changelog of the pipeline. Refactors, tests and extractor internals are
in `git log`. If one of them changes what you can read out of the published files, it
also appears here. Otherwise it does not.

There are no releases or tags: the dataset is regenerated continuously and published
on every push to `main`, so entries are dated rather than versioned.

**Additive changes do not bump `schemaVersion`.** A new optional field cannot break a
consumer that ignores it. So the version stays `1.0.0`, and this file records the
change instead. Check this file, not `schema-version.json`, to find out what is new.

---

## 2026-10-30

### Fixed

- **Fewer phantom binary records.** Two binary rules published names that were never
  Claude Code flags or env vars. The accessor-map rule read the export maps of bundled
  modules, so constants such as `CLAUDE_AI_OAUTH_SCOPES` and `CLAUDE_NAMES` became env
  vars. It now needs another key of the same map to be a proven env var. The argv rule
  read argument checks of shell commands that Claude Code analyzes, such as
  `rm --recursive` and `ps --forest`, and of embedded helper scripts. Those no longer
  count. From the next binary re-extract, these records leave the dataset.
  `--routine` loses its only binary evidence, and the `/plugin list` filters
  `--enabled` and `--disabled` are no longer CLI flags.

- **Binary-only symbols that left after 2.1.160 now get a `removed_in`.** Before, the
  binary lane inferred a removal only for a symbol last seen before 2.1.160, so a
  symbol that left later stayed current forever. Now a removal needs proof: the name
  is gone from the raw text of every release after its last sighting, for at least
  three releases. From the next binary re-extract, 95 records leave the snapshots
  after their removal version, for example `CLAUDE_CODE_HERON_TALLOW` after 2.1.228.
  A name that still appears as text stays current, because the text alone cannot
  show whether the extractor only missed it.

### Added

- **A `model` symbol type, for the Claude models Claude Code knows.** Each model
  becomes one record with its first-party API id as its `symbol`, such as
  `claude-3-7-sonnet-20250219` or `claude-opus-5-5`, and `category: "models"`. The
  description is the model's display name, such as "Opus 5.5". The records carry no
  extra fields.

  The binary lane reads two constructs. From 2.1.195 the bundle has a model registry,
  and each entry gives the first-party id and the display name. Before it, each model
  has a provider object that gives the first-party id. So models date back to 0.2.9,
  where `claude-3-7-sonnet-20250219` is the only one. A snapshot before 2.1.195 has no
  display name to cite, so its model descriptions are empty. The short registry id,
  such as `claude-sonnet-4-5`, is not the identity: it does not exist before the
  registry, and a rename of it would read as a removal. No docs page lists model ids,
  so the binary is the only lane, and a model the CLI stops naming is removed.

  The snapshots carry no `model` record until a separate data PR publishes the binary
  observations (`data/model-observations.json`).

- **A `hook_event` symbol type, for the events a hook can run on.** The `hooks`
  setting attaches a hook to an event, such as `PreToolUse`, `SessionStart` or
  `Stop`. Each event becomes one record with that name as its `symbol` and
  `category: "hooks"`. The records carry no extra fields. The description is the
  "When it fires" text of the hooks reference page.

  The binary lane reads the one array that lists every event the `hooks` setting
  accepts. That array first ships in 1.0.23 with three events, and it holds 33 at
  2.1.312. It is the whole list, so an event that leaves it is removed.
  `InstructionsLoaded` is in it at 2.1.64, out of it at 2.1.66, and back at 2.1.69,
  the release that announces it. Its record dates from 2.1.64 and the snapshots for
  2.1.66 to 2.1.68 list it too, because a record has no field for a gap. The docs
  lane reads the "Hook lifecycle" table of the hooks reference page.

  `data/docs.json` lists one `hook_event` entry per documented event from the next
  docs refresh. The snapshots carry no `hook_event` record until a separate data PR
  publishes the binary observations (`data/hook-event-observations.json`).

- **Skills named by a variable, and env reads across chunks.** The binary lane now
  reads a skill whose `name:` is a variable, also when another chunk defines that
  variable. From about 2.1.232 several skills register that way, so `/schedule`,
  `/loop`, `/setup-claude` and their aliases had no binary record in later releases.
  The env param lane now also reads a function inside its own chunk and follows a
  call to an imported function. That restores `CLAUDE_CODE_ALTGR_AS_TEXT` and the
  `CLAUDE_CODE_HTTP_PROXY` pair after the 2.1.242 chunk split. All of this takes
  effect from the next binary re-extract.

- **Env vars that Claude Code sets for a child process.** The binary lane now reads
  the keys of each object that Claude Code passes as a child's environment, for
  example the `CLAUDE_RUNNER_*` variables for the self-hosted runner's hooks. Before,
  only a read of a name counted as evidence. So a name that Claude Code only writes
  got no binary record and no binary date. From the next binary re-extract, these
  names carry `evidence: child-env` in the cache. A docs or changelog record of such a
  name can then date from its first binary sighting. Names of other tools, such as
  `GIT_TERMINAL_PROMPT`, stay unpublished under the usual ownership gate.

- **Two more docs pages.** The docs lane now reads the env-var tables of the
  self-hosted environments configuration page and the MCP page. From the next docs
  refresh, more env vars get a docs description. Examples are `CLAUDE_CODE_MCP_SERVER_NAME`
  and the `CLAUDE_RUNNER_*` variables that the runner sets for wrapper scripts and
  hooks. A description from an earlier page in the list still wins.

- **Command aliases from the binary.** The binary lane now reads each registered
  command's `aliases` list, for example `/quit` for `/exit` and `/settings` for
  `/config`. From the next binary re-extract, aliases that no other lane named appear
  as `command` records with `provenance: binary`. An alias has no description of its
  own. If the changelog or docs already named it with an estimated date, the alias
  sighting can move `first_seen` earlier. An anchored date moves only to a version
  where the command had its own name. An alias can share its spelling with a later,
  different command.

## 2026-10-29

### Fixed

- **A changelog mention alone no longer publishes a flag, command or env var.** The
  docs or the binary must also show the symbol. From the next regeneration, records
  that only the changelog named leave every snapshot. Most belong to other tools, for
  example `GIT_SSH`, `SIGTERM`, `/proc`, `/healthz` and `--separate-git-dir`. If a
  later release binary shows a withheld symbol, it publishes then.

## 2026-10-21

### Added

- **Four more docs pages feed the docs lane.** The self-hosted runner reference,
  the telemetry (monitoring) page, the plugin evals page and the ultrareview page.
  From the next docs refresh, these records carry the docs' descriptions: the
  runner, orchestrator and SCM connector flags, the runner's environment variables,
  the OTEL exporter variables, and the `plugin eval` and `ultrareview` flags. A
  variable that the runner table lists beside a flag takes that flag's text. Some records
  that were `needs_review` become `active`, and the snapshots gain documented
  variables they lacked, such as `OTEL_EXPORTER_OTLP_PROTOCOL` and
  `SELF_HOSTED_RUNNER_SIGKILL_GRACE_MS`.

### Changed

- **A flag documented for only some of its subcommands keeps that text per
  subcommand.** Some docs pages tie their sections to subcommands. Such a page can
  describe a flag under some of its subcommands while the binary also shows the flag
  under another one. In that case, the docs text now appears in `scope_descriptions`
  for the documented subcommands, and `description` is empty. Before, the text was the primary, so it answered for
  every subcommand. `--api-url` is the case: the docs describe it for the runner, but under
  `self-hosted-runner decode-token` it is a different endpoint. A flag whose
  documented subcommands cover all of its subcommands is unchanged. `--capacity`
  now has the runner text under `self-hosted-runner`, where its default is 1, not 32.

- **A `mod_element` symbol type, for the elements a mod draws with.** A `ui.render`
  hook returns a tree of elements, such as `Box`, `Text` or `Button`. Each element
  becomes one record with that name as its `symbol` and `category: "mods"`. The
  records carry no extra fields and no description.

  The binary lane reads the one object that lists, for each app, the elements it
  can draw. That object first ships in 2.1.242. It is the whole list, so an element
  that leaves it is removed: `div`, `span` and `b` were elements until 2.1.267. Which
  app draws which element is not published, because it changes from release to
  release. The docs lane reads the "Elements" table of the mods reference page.

  `data/docs.json` lists one `mod_element` entry per documented element from the
  next docs refresh. The snapshots carry no `mod_element` record until a separate
  data PR publishes the binary observations (`data/mod-element-observations.json`).

- **A `mod_render_site` symbol type, for the places a mod can draw.** A
  `ui.render` hook receives the site it is drawing as `e.component`, such as
  `AbovePrompt` or `ToolUse`. Each site becomes one record with that name as its
  `symbol` and `category: "mods"`. The records carry no extra fields and no
  description.

  The binary lane reads two constructs. From 2.1.285 the bundle holds an enum of
  every site, which it describes as the components a plugin can draw through
  `ui.render`. From 2.1.242 each site is drawn through a `useRenderInput` call that
  names it. Most sites therefore date from 2.1.242. Only the enum is the whole
  list, so a site is removed only where it leaves the enum. The docs lane reads the
  "Render sites" table of the mods reference page.

  `data/docs.json` lists one `mod_render_site` entry per documented site from the
  next docs refresh. The snapshots carry no `mod_render_site` record until a
  separate data PR publishes the binary observations
  (`data/mod-render-site-observations.json`).

- **A `mod_event` symbol type, for the events a mod hooks.** A mod reacts to Claude
  Code by passing an event name to `on(...)`, as in `on('tool.call', hook)`. Each
  event becomes one record whose `symbol` is that name, such as `tool.call` or
  `turn.start`, with `category: "mods"`. The records carry no extra fields.

  Every `mod_method` is also an event of the same name without `$.`: a hook on
  `fs.read` intercepts other mods' `$.fs.read` calls. Those events are not repeated
  as `mod_event` records. The exception is a method that the docs also list as an
  event, such as `ui.close`. It gets a `mod_event` record dated from its method.
  The `classic.<Name>` events, which are the settings hook events under another
  name, are not published either.

  The binary lane reads each string literal of the one array that lists every event
  the hooks engine accepts. That array first ships in 2.1.242, the same release as
  the mods API dispatch table, so most events date from 2.1.242. An event that only
  the binary shows lands `status: active`, like a `mod_method`. The docs lane reads
  the Events tables of the mods reference page, and each row's "Fires when" text is
  the description. The changelog lane does not read events.

  `data/docs.json` lists one `mod_event` entry per documented event from the next
  docs refresh. The snapshots carry no `mod_event` record until a separate data PR
  publishes the binary observations (`data/mod-event-observations.json`).

### Fixed

- **A subcommand a flag gained later no longer appears in earlier snapshots.** Each
  binary-proved scope now dates from the first version whose binary proved it, not
  from the flag's own `first_seen`. `data/binary-observations.json` records such a
  scope's first version in `scope_first_seen`.

- **`--hooks-dir` no longer lists `daemon` in its `scopes`.** The `daemon` scope
  came from a Windows-only check that rejects the flag. From 2.1.229 to 2.1.241 that
  check sat in the `daemon` module, and `claude daemon --help` does not list
  `--hooks-dir`. If a flag has another case label, the binary lane now ignores a
  label that only throws. From 2.1.242 the same check also hid the real scopes from
  the binary lane. The runner and orchestrator scopes now come from each release,
  not from the union.

- **The binary lane reads env vars that Claude Code reads through a helper.** Some
  code reads a variable by passing its name to a helper, for example
  `St("SELF_HOSTED_RUNNER_SIGKILL_GRACE_MS")`. The binary lane now counts that call
  as a read. From the next full re-extract, variables documented only in the docs
  get their real first version. `OTEL_METRICS_INCLUDE_VERSION` is one example: the
  dataset estimates it at 2.1.205, but the binary reads it at 1.0.50.

## 2026-10-15

### Added

- **A `mod_method` symbol type, for the mods API.** Mods call Claude Code through
  a `$` argument, as in `$.ui.toast(...)` or `$.command.register(...)`. Each method
  becomes one record whose `symbol` is the call as a mod writes it, such as
  `$.ui.toast`, with `category: "mods"`. The records carry no extra fields.

  The binary lane reads each method as a key of the mods API dispatch table in the
  release bundle. That table first ships in 2.1.242, while mods were announced in
  2.1.287, so most methods date from 2.1.242. The date means the code shipped. It
  does not say whether the API was usable before the announcement. The docs lane
  reads the "Mods API methods" table of the mods reference page, and the changelog
  lane reads backticked `$.ns.method` names. A method that only the binary shows
  lands `status: active`, like a `control_message`.

  A method is removed only where its name leaves both the dispatch table and the
  rest of the bundle for good. Leaving the table alone is not a removal:
  `$.ui.resolve` left it in 2.1.267 and is still a method.

  `data/docs.json` lists the mods reference page from the next docs refresh, with
  one `mod_method` entry per documented method. The snapshots carry no `mod_method`
  record until a separate data PR publishes the binary observations
  (`data/mod-observations.json`).

- **`mod_method` records are published.** Every snapshot from 2.1.242 on now
  carries the mods API methods available in that release, and
  `data/mod-observations.json` holds their binary observation windows. Methods
  renamed before the announcement leave at their rename: `$.fs.readFile`,
  `$.fs.writeFile` and `$.fs.listDir` at 2.1.267, and `$.session.turnCount` at
  2.1.268. `$.plugin.name`, `$.plugin.root` and `$.process.spawn` are absent from
  the dispatch table. So their dates come from the docs and the changelog, and they
  are marked `first_seen_estimated`.

## 2026-09-30

### Fixed

- **Settings descriptions decode their escapes.** The compiled binary writes some
  characters as escapes, such as `\u2014` for an em dash. The binary lane
  published those escapes as literal text, for example "section \u2014 security
  boundaries". It now decodes each string as JavaScript does. This changes about
  3,200 descriptions of 48 keys across 147 releases, from 2.1.113 to 2.1.285. The
  text is otherwise the same, and no key changes. The decoded text appears once
  those releases are re-scraped.

- **Three env vars are first seen earlier.** `CLAUDE_CODE_BS_AS_CTRL_BACKSPACE`
  moves from 2.1.133 to 2.1.113, and `CLAUDE_CODE_HTTPS_PROXY` and
  `CLAUDE_CODE_HTTP_PROXY` move from 2.1.136 to 2.1.116. From 2.1.113 to 2.1.132
  the compiled binary embeds its bundle twice, so each function is defined twice
  with the same text. The binary lane read that as a reused minified name and
  dropped these env vars, which Claude Code reads through a function parameter.
  The lane now treats identical definitions as one function. The new dates appear
  once 2.1.113 to 2.1.132 are re-extracted.

- **Settings descriptions written as joined strings are published.** Claude Code
  writes some settings descriptions as `"…"+"…"`, as a template of string
  constants, or as `"…"+` a constant name. The binary lane read only a single
  literal, so these keys had no binary description. From 2.1.64 on, about 2,250
  such descriptions across 184 releases were empty. The lane now evaluates the
  joined string. If every binding of a name in its chunk folds to the same
  text, the lane uses that text. Otherwise the description stays empty, as
  before. No key and no existing description changes. The new descriptions
  appear once the affected releases are re-extracted.

## 2026-09-29

### Fixed

- **51 settings keys are observed in the binary again from 2.1.281.** They are
  the 7 `permissions.*` keys, the 41 `sandbox.*` keys, and `attribution.commit`,
  `attribution.pr` and `attribution.sessionUrl`. From 2.1.281 Claude Code builds
  `permissions` and `sandbox` as zod `lazy` schemas, and `attribution` as a
  union of a boolean and an object. The binary lane read neither shape. So
  `data/binary-observations.json` stopped these keys at `last_seen: 2.1.280`,
  but every later binary still carried them. The records in the version
  snapshots stayed published. The binary lane now reads a `lazy` schema's inner
  schema and a union's object member. `last_seen` follows the binary once
  2.1.281 onward are re-scraped.

## 2026-09-26

### Changed

- **Plugin symbols cite the new plugin docs pages.** Anthropic split the
  `plugins-reference` page into `plugins/cli-reference` and
  `plugins/manifest-reference`. A record with a `source_url` on
  `plugins-reference.md` now cites the new page that documents it: the
  `claude plugin` subcommand flags cite `plugins/cli-reference.md`, and
  `CLAUDE_PLUGIN_DATA` cites `plugins/manifest-reference.md`. `--sparse` and
  `--claudeai` also get docs descriptions from the `plugin marketplace add` table.
  `--help` loses its docs description, because neither new page has a table row
  for it.

## 2026-09-17

### Fixed

- **A passing changelog mention no longer outranks the binary sighting of a scoped
  flag.** A bullet that names a flag incidentally registers it in the changelog lane
  at that version. The binary lane sees some flags only as a subcommand's argv
  switch. A scoped observation like that cannot re-date a record, so the changelog
  date won. But that date is a mere upper bound. An earlier sighting of the same
  token refutes it. When containment proved the flag's complete scope set, the
  sighting now corrects the date. `--drain-wait-sec` read `2.1.275` after the
  2.1.275 changelog named it in a bug-fix bullet. That dropped it from every
  snapshot back to its real 2.1.224 sighting. `--base-dir` (`2.1.225`),
  `--kill-session-after-min` (`2.1.260`) and `--use-anthropic-git-proxy`
  (`2.1.267`) carried the same error. All four now read `2.1.224`. An anchored date
  is still safe from a scoped sighting. That is what keeps one `--capacity` record
  from answering for both `remote-control` and `self-hosted-runner`. `--help` still
  corrects nothing. No scope set of it can be complete.
- **An audited binary description now fills a record another lane left empty.** The
  maintainer-audited `--help` text was reachable in one place only: the branch where
  the binary lane adds a symbol no other lane knew. A symbol the changelog also
  named therefore published with an empty description. `--drain-wait-sec`,
  `--kill-session-after-min` and `--use-anthropic-git-proxy` all shipped that way.
  The text now fills an empty description whatever lane owns the record. It never
  replaces text a lane supplied. A symbol with a per-version description timeline
  is left to that timeline, which is the more exact answer at every version.
  `provenance` is untouched, and only `description_source` credits the text. **No
  data ships in this change.** The regeneration that corrects the four records is a
  separate data PR.

## 2026-09-04

### Fixed

- **Settings keys resolve inside their own module from 2.1.242 on.** The binary
  settings lane walks the embedded zod schema. It follows each sub-schema reference
  to its definition by minified name. Since the 2.1.242 code-split, every chunk
  minifies its own names. The lane still searched the flat concatenation, so a
  reference sometimes landed on an unrelated object in another chunk. Every dataset
  regenerated since then carried phantom `config_key` records built that way.
  Examples are `hooks.session_id` (2.1.242), `cleanupPeriodDays.permission_policy`
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
  `--help` walk showed that `--mocks` (`plugin eval`), `--post` and `--no-post`
  (`ultrareview`) are genuine, user-facing flags. They carry their own first-party
  descriptions. So they join `PROMOTED_BINARY_SYMBOLS`, with `status: "active"`,
  `confidence: "high"` and `description_source: "help"`. `--eval-dir` was left
  `needs_review`. It names a different directory under `plugin eval` (the eval-cases
  dir to run) than under `plugin eval init` (the dir to write cases into). One
  `type:symbol` record cannot hold both. `--api-url` is held to the same bar.

- **Five commander-flag scopes a fresh `--help` walk found.** The curated scope table
  was captured at 2.1.226. A full `claude <path> --help` walk ~25 releases later
  surfaced commander flags whose scope only help can resolve. The binary lanes see
  hand-rolled parsers, not commander registrations. `--eval-dir` (`plugin eval` and
  `plugin eval init`), `--mocks` (`plugin eval`), and `--post` / `--no-post`
  (`ultrareview`) gained scopes. `--yes` gained `plugin install` / `plugin update`.
  Each was a false "no". A consumer asking "is `--post` accepted under `ultrareview`?"
  now gets yes. `--remote` was deliberately left unscoped despite appearing under
  `plugin tag --help`. It is a hidden top-level flag (a deprecated `--cloud` alias).
  So a scope on it falsely claims that `claude --remote` is rejected.

- **Dropped six non-Claude Code env vars the changelog lane pulled from prose.** The
  changelog names external-tool, shell, and OS variables incidentally in backticks,
  and the broad `env_var` pattern seeded them as symbols. `GH_TOKEN` / `GITHUB_TOKEN`
  are the `gh` CLI / GitHub Actions auth convention. `OPTIND` / `RANDOM` are bash
  builtins, shown only as arithmetic-assignment examples in a permission-check
  bugfix. `TMPDIR` / `TEMP` are OS temp-dir vars that a bullet says Claude Code no
  longer sets. They now join the changelog-lane denylist alongside
  `PATH`/`HOME`/`GIT_DIR`. Consumers filtering `type: "env_var"` no longer see these
  six. The binary lane still observes them raw and withholds them at publication, so
  no genuine Claude Code var is lost.

- **`--all` now records `respawn` among its scopes.** `claude respawn <id>|--all`
  accepts `--all`. But the background-session subcommands are hand-rolled parsers
  that the binary scope lane was unable to read. They string-compare the argument
  instead of using `case"--flag":` labels. Since 2.1.242 they also sit outside the
  modules that lane partitions on. A new `extractBgSubcommandScopes` reads them (the guard rejecting
  every other dash-led token is the complete accepted set), and `respawn` joins
  `--all`'s curated scopes. A consumer asking "is `--all` accepted under `respawn`?"
  now gets yes instead of a false no.

- **Subcommand `scopes` restored for the code-split era (2.1.242+).** The binary scope
  lane's containment keyed on esbuild namespace-module headers. The 2.1.242 Bun
  ESM code-split removed them: each subcommand parser became its own `// @bun @bytecode`
  chunk. So the lane returned nothing from 2.1.242 on. The ~47 `self-hosted-runner`
  flags kept their scopes only through `binary-observations` persisting the last
  pre-split reading. The lane now partitions by chunk (a header-less chunk is itself
  one module), mirroring the control lane's 2.1.242 fix. Pre-split output is
  unchanged. From 2.1.242 the scopes are read live again. So a switch-case flag first
  seen in the split era now publishes with its owning subcommand. Before, such a flag
  was withheld for want of a complete scope.

## 2026-08-22

### Fixed

- **Settings keys keep their documented descriptions.** Anthropic split the settings
  page in two, moving every key definition to a settings reference page. The docs lane
  still read the original page, still parsed it, and found nothing there. So every
  documented `config_key` lost its first-party description and `source_url`. It dropped
  from `provenance: "docs"` to `provenance: "binary"`, and fell back to
  `status: "needs_review"`. The lane now reads the reference page, and refuses to
  publish a run in which a page meant to carry symbols stops yielding them.
  Consumers reading `config_key` descriptions or filtering on `status` see the
  documented surface restored. They also see the keys that the new page documents and
  the old one did not.

## 2026-08-15

### Added

- **`scope_descriptions` on `cli_flag` records, for per-subcommand description
  overrides.** A flag whose official docs describe it differently under different
  subcommands now carries a `scope_descriptions` map. For example, `--force` reads
  "Overwrite an existing `.claude-plugin/` at the target" under `plugin init`. Under
  `plugin tag` it reads "Create the tag even if the working tree is dirty or the tag
  already exists". Keys are a subset of `scopes`. Resolve a scope's text as
  `scope_descriptions[scope] ?? description`. A scope the docs do not describe
  separately (the flag's `install` scope, say) is absent rather than given a wrong
  description. The field is optional and additive. A consumer that ignores it still
  gets a correct primary `description`, so `schemaVersion` stays `1.0.0`.

## 2026-08-14

### Added

- **`control_message` records, for the stream-json control protocol's request
  subtypes.** Each is extracted from the release binary's own schema declarations.
  So every snapshot from the protocol's floor onward now carries the subtypes live at
  that version. They add two fields that appear on no other type and are required here:
  `family` (currently always `control_request`) and `direction`
  (`host_to_cli`, `cli_to_host`, or `null`). A `direction` of `null` means the CLI had
  not yet declared the message's direction at that version. It is a value, not a
  missing field.
- **A security contact at <https://claustodian.dev/.well-known/security.txt>.** An
  RFC 9116 file pointing at the private reporting channels already named in
  `SECURITY.md`. Adds no data of its own. (#233)

### Changed

- **`confidence: "low"` is now a value you can observe.** It marks a control subtype
  that the binary only ever _dispatches_. The CLI handles the message, but no schema in
  the bundle describes it. Every other lane grades `high` or `medium`.
- **A `provenance: "binary"` record can now carry `status: "active"`.** Until now every
  binary-sourced record stayed `needs_review` until a human checked it.
  `control_message` records are exempt: the lane reads the subtype's name off the CLI's
  own declaration rather than inferring it from free text, so existence is established
  by the artifact.
- **Read `first_seen_estimated`, not `confidence`, to tell whether a date is exact.**
  On other lanes, `confidence: medium` travels with an estimated `first_seen`. On
  `control_message` records, confidence grades evidence strength instead, so a `low`
  record can still be exactly dated.

### Removed

- **The OS/shell environment variables `PATH`, `HOME`, `LANG`, `COLUMNS`, `LINES`,
  `OLDPWD`, `DIRSTACK`, and `XDG_DATA_HOME` are no longer published.** The changelog
  lane seeded them from incidental prose. A bullet mentioning a stale `PATH` was
  enough. But Claude Code reads these without owning them. They belong to the OS and
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

  If the binary help text had not changed since that version, the resolver kept a
  description. That test was a proxy for whether the docs text still applied, and
  it is not a sound one. `/review`'s binary text is unchanged since 2.1.186, while
  its docs text describes behavior that began at 2.1.223.

  If a description's own text names a release later than a version, the description
  is now refused at that version. The same is true for a backticked symbol in the
  text whose `first_seen` is later than that version. The symbol can be of any of the
  four types this dataset publishes, where the span holds that symbol alone. The check is self-consistency against
  the dataset, not a judgement about prose. A symbol the dataset does not know is
  ignored, because absence of a record is not evidence that the symbol did not
  exist.

  When the binary observed the symbol at that version, its text replaces the docs
  text and `description_source` becomes `binary`. `/cost` at 0.2.21 becomes "Show
  the total cost and duration of the current session" instead of "Alias for
  `/usage`". That command did not exist until 2.0.0.

  Otherwise the description keeps the leading sentences that name nothing later
  than the version. These descriptions are an era-correct opening plus sentences
  appended as behavior grew, so truncation preserves correct text that a blanket
  removal discards.

  If the binary lane has no text to fall back on and either of two things is true, a
  description becomes empty. Its first sentence already names something later. For
  example, `MCP_OAUTH_CALLBACK_PORT` is blank before 2.1.30, the release that
  introduced the `--callback-port` that its only sentence points at. Or the sentence that trips the
  guard is _correcting_ the ones before it, in which case the prefix cannot be
  published either.

  That second case empties records whose opening sentence reads fine.
  `ENABLE_TOOL_SEARCH` has eight sentences and only the last is a "Before v2.1.221"
  correction, yet the whole record is blank below that release. A correction is
  known to invalidate something earlier, and sentence granularity cannot say which.
  So the honest answer is to publish none of it rather than guess which half
  survived. The binary lane does not record env var help text, which is why these
  cases are env vars.

  Nothing changes at the newest version. The guard skips that snapshot outright
  rather than relying on no release comparing greater. A release can be known to the
  binary lane before the changelog has a heading for it. So the data never guaranteed
  that property.

---

## 2026-08-13

### Fixed

- **Four `scopes` lists said a flag was invalid where it is accepted.** `scopes` is
  the COMPLETE set of subcommands a flag works under. So a non-empty list also
  asserts "not accepted on bare `claude`". That makes an incomplete list a false
  no, not merely a partial yes. Two independent holes in the curated sweep produced
  four of them.

  The sweep stopped at depth two, so it never read the five depth-three invocations
  `claude` accepts at 2.1.226. They are `plugin eval init` and
  `plugin marketplace {add,list,remove,update}`:

  | flag            | was                    | now                                                |
  | --------------- | ---------------------- | -------------------------------------------------- |
  | `--interactive` | `project purge`        | + `plugin eval init`                               |
  | `--json`        | 5 invocations          | + `plugin marketplace list`                        |
  | `--scope`       | 10 invocations         | + `plugin marketplace add`, `… marketplace remove` |
  | `--sparse`      | _(no scopes recorded)_ | `plugin marketplace add`                           |

  Separately, `--remote` published as `["plugin tag"]` and so claimed
  `claude --remote` is invalid. It is not: `--remote` is a hidden top-level
  deprecated alias for `--cloud`. It is documented that way on the official CLI
  reference page and handled in the 2.1.226 bundle's top-level argv. Being hidden is
  exactly why the sweep mis-scoped it. The rule excludes what bare `claude --help` accepts,
  and a hidden flag never appears there. **`--remote` now carries no `scopes` at
  all**, which reads as "no scope information" rather than a false restriction.

### Added

- **`--interview` is scoped to `plugin eval init`.** It is hidden on the subcommand
  it belongs to, so the help sweep missed it. But nothing false had shipped. It had no
  scope before.

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

  Each cost the dataset twice. The command was lost from the docs lane. The argument
  was published as a `claude` CLI flag carrying the _command's_ description. For
  example, `--force` shipped as "Reload all active plugins to apply pending
  changes without restarting", which describes `/reload-plugins`.

  `--fix` had no evidence in any other lane and is removed. `--force` and
  `--dry-run` are real flags the binary lane observes independently. They keep
  their records and pick up correct descriptions. `/code-review`, `/import`,
  `/reload-plugins` and `/review` gain their documented descriptions.

- **Six subprocess flags no longer publish as Claude Code CLI flags.** The changelog
  lane suppresses a subprocess tool's own flags in a bullet that lists them as
  examples. But the rule only recognised an `(e.g., …)` lead-in. Two bullets write the
  example list as a bare parenthetical opening straight off the word "flags", and both
  leaked:

  - 2.1.214: "`docker` commands … carrying daemon-redirect flags (`--url`,
    `--connection`, `--identity`, …)" published `--url`, `--connection` and
    `--identity` as `cli_flag` records with `confidence: "high"` and no evidence in
    any other lane. They are removed from every snapshot from 2.1.214 on.
  - 2.1.229: "`/commit-push-pr` so git/gh commands with dangerous flags (`--force`,
    `--amend`, `--no-verify`, etc.)". Without this fix, that bullet adds `--amend`. It
    also moves `--no-verify` from `provenance: "binary"` / `first_seen: "2.1.224"` to
    `provenance: "changelog"` / `first_seen: "2.1.229"`, which drops its help
    description. And it flips `--force` from `provenance: "docs"` to
    `provenance: "changelog"`. None of that now happens.

  The rule still requires a subprocess tool name, the word "flags", and at least one
  flag token inside the clause. So a bullet introducing a genuine first-party flag is
  untouched.

---

## 2026-08-09

### Added

- **A `control_message` symbol type in the schema, for the stream-json control
  protocol.** Claustodian already tracks the transport for that channel
  (`--input-format`, `--output-format`, `--replay-user-messages` and friends). This
  adds the vocabulary that travels inside it. That vocabulary is the `control_request`
  subtypes that a host application must implement to drive the CLI. Examples are `initialize`,
  `set_permission_mode`, `hook_callback` and `remote_control`. Records carry two new
  fields: `family` (currently always `control_request`) and `direction`
  (`host_to_cli`, `cli_to_host`, or `null`).

  **`direction: null` means "not observable for this record", not "this version
  predates the split".** It arises two ways. The CLI began declaring the two
  directions as separate schema unions at 2.1.133. So every record in an older
  snapshot has null. But a subtype evidenced only by a call site or a dispatch
  belongs to no directional union at _any_ version. So it is null there too. In the
  2.1.226 snapshot, that includes `remote_control`, alongside sibling records that
  carry a direction. Null is never backfilled from a later release. Descriptions are
  likewise absent before 2.1.63.

  **No data ships in this change**. The schema accepts these records, and nothing
  emits them yet. Additive, so `schemaVersion` stays `1.0.0`.

- **An MCP endpoint at <https://claustodian.dev/mcp>.** The same records, queryable
  over Model Context Protocol instead of by fetching and filtering a snapshot
  yourself: `list_versions`, `get_symbol` (does this flag / command / settings key /
  env var exist at version X, with its full record) and `search_symbols`. Speaks MCP
  revision `2026-07-28`. That is the per-request-metadata revision, with no
  `initialize` handshake and no sessions. **No new data and no schema change**: every answer comes
  from the published `data/` files, and the JSON endpoints remain the source of
  truth. There is deliberately no "did this ever exist" tool. That question needs
  `catalog.json`, whose parse alone exceeds the endpoint's CPU budget. Use
  `catalog.json` directly for it. (#176)
- **A discovery catalogue at <https://claustodian.dev/.well-known/api-catalog>.** An
  RFC 9727 linkset pointing at the existing data endpoints, `llms.txt` and the record
  schema. With it, an agent can find them from a fixed path without knowing about
  `llms.txt` first. Adds no data of its own. (#171)

## 2026-08-08

### Added

- **`category: "cli-internal"`** on `cli_flag` records. Marks a flag hidden from
  `claude --help`. The flag works and the CLI accepts it, but something else sets it (a
  spawning parent, an orchestrator, a deep link). So passing it yourself usually does
  nothing. `category: "cli"` flags are the user-facing ones. Derived from commander's
  `.hideHelp()`. (#153)
- **`category: "global-config"`** on `config_key` records. These keys belong in
  `~/.claude.json`. If they are written to `settings.json`, they are **silently
  ignored**. Before, the dataset was unable to express that distinction. (#145)

### Changed

- **The published base URL moved to <https://claustodian.dev>.** The old
  `https://schubydoo.github.io/claustodian` base 301-redirects there with the path
  preserved, so any client that follows redirects keeps working. A bare `curl` without
  `-L` gets the redirect page instead of JSON. (#154)
- Settings keys from the official `settings.md` docs page joined the docs lane, so
  many `config_key` records gained authoritative descriptions. (#143)
- A parent settings object no longer inherits its first child's description. Eight of
  twenty parents were publishing a child's sentence. (#147)
- 39 more flags gained `description_source: "help"` descriptions verified against
  first-party CLI help output. (#139)

## 2026-08-07

### Added

- **`scopes`** (optional, `cli_flag` only) is the complete list of **full invocation
  paths** a flag is accepted under, for example `["remote-control"]` or `["plugin eval"]`.
  Present means the flag is **not** accepted on bare `claude`, and a multi-word path
  means it is not accepted on the parent either: both `claude --sandbox` and
  `claude plugin --scaffold` fail. **Absent does not mean top-level**. It means no
  scope information was recorded, which is true of most of the dataset. (#133)
- **First `type: "config_key"` records**: `settings.json` keys read out of the schema
  Claude Code embeds, with `category: "settings"` or `"settings-internal"` (the latter
  marked `@internal` upstream). The type was in the schema enum from the start.
  Records first appeared on this date. (#129)

## 2026-07-14

### Added

- **`data/catalog.json`**: one entry per `(type, symbol)` **ever** observed,
  including removed symbols, with the full lifecycle. Per-version snapshots contain
  only what was live at that version, so this is the only file that can answer "did X
  ever exist?". (#67)

  It is the one published file with no `.yaml`/`.toml` sibling: it is built after the
  export step runs.

## 2026-07-09

### Added

- **`deprecated_in`** (optional): the version a symbol was marked deprecated. The
  symbol stays present and its `status` flips to `"deprecated"`. It can be removed
  later, so the states compose. (#41)
- **`data/binary-descriptions.json`**: per-symbol description timeline, keyed
  `"<type>:<symbol>"`, as change-point eras. Take the last era whose `from <= Y` for
  the text at version Y. (#43)
- **`description_source`** gained `"binary"` and `"help"`, alongside the existing
  `"docs"` and `"changelog"`. (#39)

## 2026-07-06

### Added

- **`data/binary-observations.json`**: raw binary-lane first/last-seen observations.
  Provenance detail rather than a consumer endpoint, but it is published. (#28)

## 2026-07-05

### Added

- **`provenance: "docs"`**, plus **`description_source`** and
  **`first_seen_estimated`**. `first_seen_estimated: true` marks a `first_seen` that
  is an **upper** bound. Such a date comes from an incidental changelog mention, or
  from a docs page with no stated `min-version`. So the true version can be earlier. Those records carry
  `confidence: "medium"`. (#18)
- **`data/docs.json`**: symbols and descriptions harvested from the official docs
  pages. (#18)

### Removed

- **`platforms`**: dropped before v1.0. It was never populated, so nothing was able to
  depend on it.

---

## Notes for consumers

- **Snapshots are not immutable.** A published `versions/<X.Y.Z>.json` is regenerated
  whenever a lane finds new evidence, including for long-past releases. Records gain
  descriptions, `first_seen` gets sharpened, and symbols are _added_. So absence from
  an old snapshot is provisional. Revalidate rather than pinning.
- **`first_seen` is a lower bound**. It is the earliest version in which Claustodian
  observed a symbol. It does not prove which version the symbol first appeared in. `first_seen_estimated: true` marks the ones
  that are an _upper_ bound instead.
- Field-level detail lives in [`schema/symbol.schema.json`](schema/symbol.schema.json)
  and the [agent guide](examples/README.md).
