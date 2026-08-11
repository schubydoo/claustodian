# Architecture

How Claustodian turns three public Anthropic sources into one per-version snapshot
per release. Read this before changing an extractor; read
[the regeneration runbook](runbooks/regenerating-the-dataset.md) before running one.

## The question the design answers

> Does symbol X exist in Claude Code version Y, and what did it do at that version?

Everything below follows from wanting that answer to be **checkable**. A record is
only ever asserted because something official showed it, and every record carries the
lane that proved it.

## The three lanes

| Lane          | Source                                | Authoritative for                                                             |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| **changelog** | `anthropics/claude-code CHANGELOG.md` | existence, and the release a symbol was announced in                          |
| **docs**      | `code.claude.com/docs` pages          | descriptions, and an anchored `first_seen` when a page states a `min-version` |
| **binary**    | published release binaries            | undocumented symbols, earlier `first_seen`, cliff-aware removals              |

Binary finds land as `status: needs_review` until a first-party description confirms
them. That is a curation state, not a doubt about existence — the binary proved the
symbol is there.

## Script map

Pipeline scripts live in `scripts/`. Each is a module with a `main` guard, so they are
importable in tests and runnable via the matching npm script.

| Script                  | Lane      | Reads                           | Writes                                                                          |
| ----------------------- | --------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `scrape-binary.ts`      | binary    | one release from the CDN        | `binary-cache/<version>.json`                                                   |
| `reextract-binaries.ts` | binary    | the local archive               | `binary-cache/` (rebuilt)                                                       |
| `extract-bundle.ts`     | binary    | one bundle's source text        | — (library)                                                                     |
| `slice-bundle.ts`       | binary    | one release artifact's bytes    | — (library)                                                                     |
| `settings-schema.ts`    | binary    | the embedded zod schema         | — (library)                                                                     |
| `env-registry.ts`       | binary    | the typed env registry          | — (library)                                                                     |
| `argv-scopes.ts`        | binary    | esbuild module headers          | — (library)                                                                     |
| `backfill-binary.ts`    | binary    | `binary-cache/`                 | `data/binary-observations.json`                                                 |
| `binary-lane.ts`        | binary    | observations                    | — (policy)                                                                      |
| `fetch-docs.ts`         | docs      | docs pages + observations       | `data/docs.json`                                                                |
| `scrape-changelog.ts`   | changelog | changelog + observations + docs | `data/versions/*.json`, `index.json`, `latest.json`, `binary-descriptions.json` |
| `build-catalog.ts`      | —         | `data/versions/*.json`          | `data/catalog.json`                                                             |
| `generate-exports.ts`   | —         | `data/**/*.json`                | sibling `.yaml` / `.toml`                                                       |
| `validate-schema.ts`    | —         | `data/**/*.json`                | — (gate)                                                                        |
| `check-coverage.ts`     | —         | changelog vs data               | — (gate)                                                                        |
| `diff-snapshots.ts`     | —         | two snapshots                   | — (tool)                                                                        |
| `find-removals.ts`      | changelog | changelog prose                 | — (proposes)                                                                    |
| `removals.ts`           | changelog | curated retirement lists        | — (policy)                                                                      |

`scrape-changelog.ts` is where the lanes converge: it reads the changelog, folds in
`data/docs.json` and `data/binary-observations.json`, and assembles every snapshot.

## Why the regeneration order is what it is

```
reextract-binaries  →  backfill-binary  →  fetch-docs  →  scrape --all
```

Not alphabetical, and not obvious. `fetch-docs` resolves settings-page key paths
**against `data/binary-observations.json`** — the docs group keys by topic rather than
by JSON nesting, so a page's "Permission settings" table can list a key the schema
holds flat. The only way to know which is which is to check the binary-derived schema.
Run the docs lane first and it resolves against a stale schema, silently.

The runbook has the commands, the reconciliation step that has to happen first, and
the verification. It is a procedure; this is the reason behind it.

## Invariants

Each of these was learned from a defect that shipped.

**Identity is `type:symbol`, and nothing in it may come from mutable text.** Typing
settings keys off an `@internal` prefix meant that when Anthropic dropped the prefix at
2.1.154, `disableWorkflows` published a false removal — the old type disappeared and a
new type appeared in the same release. Internal-ness is now `category`, which
describes rather than identifies.

**A field that can vary by version needs a timeline _and_ an absolute resolver.** A
record-level value is the tip's answer. If it can differ by version, resolve it at
snapshot assembly from an era list — and the resolver must return an absolute value,
never fall back to the record's current one. This has cost four review rounds across
four fields (`category`, `scopes`, `hidden_eras`, then `category` again); the two that
were written as absolute resolvers were never wrong.

**Observations are evidence; policy lives in `binary-lane.ts`.**
`data/binary-observations.json` records what was seen. What publishes, how it is
categorised, and whether it may re-date an existing record are interpretation. Note
`mayRedateFromBinary` is deliberately stricter than `isPublishableBinaryFlag`: a
subcommand-scoped flag publishes, but its dates describe that subcommand's flag, and
identity is flat — a `self-hosted-runner` sighting must not answer "when did
`--capacity` appear?".

**Prefer structural evidence over curated lists.** Curated lists rot silently. Every
lane that works is anchored on something the bundle states about itself:

- **scope** — esbuild module containment. `var NS={};ut(NS,{…})` headers partition the
  bundle, so a parser and the `Usage: claude <path>` banner it prints are in the same
  module by construction. Not proximity: both nearest-binding heuristics in this
  codebase took several review rounds to bound correctly.
- **`cli-internal`** — commander's `.hideHelp()`. Every flag it marks is absent from
  `claude --help` yet accepted; no public flag carries it.
- **settings keys** — the embedded zod schema, including feature-gated
  `shape:()=>({…})` fragments identified by a sibling `buildGate`.
- **env vars** — the typed registry `NAME:()=>ref`, which proves env-var-ness
  structurally instead of guessing from the name.

**When a construct is unrecognised, throw.** A silent skip reads downstream as a
removal, and removals are the most expensive thing to get wrong.

## Why a green test suite is not enough

Unit tests have caught none of the extractor defects in this project. Two examples,
both of which passed their tests:

- `new X("--flag"` as a look-back matched `new lr("--configure-git: could not restore
hook stubs …")` — an error message, not a flag registration. Only a before/after diff
  against a real 2.1.224 bundle caught it.
- The `case "--flag":` rule was sound, but every flag it found was subcommand-scoped.
  Running `claude --verify` at a real prompt is what exposed it.

What does work: diff the extractor's output against the committed
`binary-cache/<version>.json`, read the added symbols one by one, sweep several eras
rather than only the tip, and run the real binary. The archive is a maintainer-local
artifact, but the installed binary at `~/.local/share/claude/versions/<version>` is a
plaintext bundle and can be read directly.

## Publishing

`publish-pages.yml` assembles `_site/` from `data/`, `site/`, `llms.txt` and the
brand assets, then deploys via OIDC. Generated YAML/TOML and `data/catalog.json` are
built in CI and never committed. See
[the publishing runbook](runbooks/publishing.md) — in particular, GitHub Pages does
not rebuild on a custom-domain change, which has already caused one outage.

## What is deliberately not here

- **No API.** Static files only: cacheable, vendorable, and readable offline.
- **No `internal_config_flag` records.** The type is in the schema enum and unused;
  internal-ness is a `category`, per the identity invariant above.
- **No `control_message` records yet.** The extractor now runs in the extraction
  loop and its output is cached per version, but nothing assembles those
  observations into records and the site cannot filter them. The PR that emits them
  follows separately, and the dataset regeneration after that.
- **No LLM-authored content in the dataset.** Descriptions come from the docs, the
  changelog, or the binary's own text. A generated summary would be an unverified
  artifact in a dataset whose whole value is that claims are checkable.
