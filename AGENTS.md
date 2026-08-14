# AGENTS.md

Instructions for AI coding agents working in this repository. Human contributors
should read [CONTRIBUTING.md](CONTRIBUTING.md) — this file is the machine-facing
equivalent and repeats the parts an agent needs in-context.

> Claude Code users: see [CLAUDE.md](CLAUDE.md). It imports this file and adds only
> Claude-specific notes.

---

## The project

A static, versioned dataset of the Claude Code surface — every CLI flag, environment
variable, command and settings key, tagged with the version it was first observed in.
Three lanes (changelog, docs, release binaries) produce one JSON snapshot per release,
published to <https://claustodian.dev>.

The whole value is that every claim is checkable against something Anthropic
published. A record asserted without evidence is worse than a missing record.

## Critical commands

```bash
npm test                  # vitest
npm run validate          # every data/ file against the schema
npm run lint              # eslint
npx prettier --check .    # CI gate; generated data is excluded
npx tsc --noEmit
```

Full regeneration — **the order is load-bearing, not alphabetical**:

```bash
npm run reextract-binaries   # 1. archive      -> binary-cache/
npm run backfill-binary      # 2. binary-cache -> data/binary-observations.json
npm run fetch-docs           # 3. docs pages   -> data/docs.json
npm run scrape -- --all      # 4. everything   -> data/versions/, index, latest
```

`fetch-docs` resolves settings key paths against `data/binary-observations.json`, so
the binary lane must land first or the docs lane resolves against a stale schema.
**Read [the runbook](docs/runbooks/regenerating-the-dataset.md) before running any of
this** — there is a reconciliation step that has to happen first.

## Architecture map

| Path                          | What                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `scripts/extract-bundle.ts`   | positive-evidence extraction from a release bundle       |
| `scripts/control-lane.ts`     | AST extraction of the stream-json control protocol       |
| `scripts/binary-lane.ts`      | policy: what publishes, how it is categorised, re-dating |
| `scripts/backfill-binary.ts`  | observations → `data/binary-observations.json`           |
| `scripts/fetch-docs.ts`       | official docs pages → `data/docs.json`                   |
| `scripts/scrape-changelog.ts` | changelog + all lanes → `data/versions/*.json`           |
| `schema/symbol.schema.json`   | the record contract                                      |
| `data/`                       | **generated** — never hand-edit                          |
| `site/index.html`             | the whole site, hand-written, no build step              |

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Hard rules

- **IMPORTANT: never ship a code change and a dataset regeneration in the same PR.**
  A re-extract touches ~800 files; review tooling refuses PRs over 500 and exclusions
  do not reduce the count, so the one thing that needed review is the one thing that
  cannot get it. Code PR first, data PR second.
- **IMPORTANT: `reextract-binaries` reads only the archive and clears `binary-cache/`
  first.** A version present in the cache but not the archive is destroyed by a run
  that reports success. Reconcile the four version sets first — the npm packument
  is what makes the local three checkable, since they can only disagree with each
  other and a release absent from all three raises nothing:
  `bash scripts/check-version-sets.sh`.
- **YOU MUST assert a symbol only on positive evidence.** When a construct is
  unrecognised, throw — a silent skip reads downstream as a removal.
- **A green test suite is not evidence for an extractor change.** Diff against the
  committed `binary-cache/<version>.json` and run the real binary. Every extractor
  defect in this project passed its tests.
- Identity is `type:symbol`. Never derive any part of it from mutable text.
- A field that can vary by version needs a timeline **and** a resolver returning an
  absolute value. Never fall back to the record's current value.
- Never format generated data. `binary-cache` is single-line JSON; prettier would be
  undone by the next regeneration and break the zero-diff check.
- Never hand-edit `data/` or the `.yaml`/`.toml` exports — they are generated.
- Never commit to `main`. Branch, then PR.

## Workflow preferences

- **Verify before reporting.** A status line in a doc, a TODO, or a recalled memory is
  a cache, not truth. Confirm against `git log`, `gh pr view`, or the code.
- **Absence of evidence is not evidence of absence.** Before treating an empty result
  as a finding, prove the instrument can produce a positive — run it against something
  you know matches.
- **Say what actually happened.** If tests fail, show the output. If a step was
  skipped, say so.
- Reasoning belongs in the commit message; PR bodies stay short.
- Conventional commits: `feat(binary)`, `fix(settings)`, `docs`, `chore(data)`.
- If a change alters what a consumer can observe, add a [CHANGELOG](CHANGELOG.md)
  entry.

## Gotchas

- A version snapshot contains only symbols available at that version, so presence
  **is** availability. `first_seen`/`removed_in` comparison is only needed against
  `latest.json` or `catalog.json`.
- `catalog.json` has no `.yaml`/`.toml` sibling — it is built after the export step.
- Publishing has a trap: GitHub Pages does **not** rebuild on a custom-domain change.
  See [the publishing runbook](docs/runbooks/publishing.md).
- The eight versions that 404 on the CDN are permanent gaps, not a fetch bug.
