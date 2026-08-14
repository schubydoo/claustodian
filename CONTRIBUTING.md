# Contributing to Claustodian

Thanks for helping keep Claude Code's surface documented. Please read the provenance policy first — it's the core of this project's trustworthiness.

## Provenance policy (the important part)

Claustodian uses only material Anthropic has **publicly published and distributed**:

- The official `CHANGELOG.md` in `anthropics/claude-code`.
- The official Claude Code documentation pages (`code.claude.com/docs`).
- Officially published release binaries (GitHub release assets and npm-published bundles).

It does not use leaked or otherwise non-public material. **Do NOT contribute data derived from:**

- Leaked or accidentally-exposed material (e.g. source-map leaks).
- Any other non-public source.

A record whose accuracy depends on non-public material will be rejected. This policy is what lets consumers trust the dataset and cite it; a single tainted entry undermines the whole thing.

## The three provenance lanes

| Lane      | `provenance` | Trust                     | Merge policy                                                                                                                                                                                                                                                                              |
| --------- | ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changelog | `changelog`  | `confidence: high`        | Authoritative — bot PRs are auto-mergeable once CI passes.                                                                                                                                                                                                                                |
| Docs      | `docs`       | `high` / `medium`         | Official docs pages; supply authoritative descriptions and, via a doc `min-version`, an anchored `first_seen`. Absent a min-version, `first_seen` is an estimate (`first_seen_estimated`, `confidence: medium`).                                                                          |
| Binary    | `binary`     | `medium` / `high` / `low` | Lands as `status: needs_review` at `confidence: medium`; a human must confirm before it flips to `active` (and to `high`). **Except `control_message`**, which lands `active` and grades `confidence` by the rule in `schema/symbol.schema.json`, with no human confirmation — see below. |

`first_seen_estimated: true` marks an upper bound (an incidental changelog mention, or a docs page with no min-version); the binary lane confirms these — and, for `control_message`, produces them: a subtype can be invisible to extraction until its declaration becomes provable, so its date is the version it became visible. That bound does not clear in later versions; the admission signal is read at `first_seen` and stays. Never move a `binary`/`needs_review` record to `active` without confirming the symbol against an official artifact. Keep the lanes distinct.

**Why `control_message` is exempt from `needs_review`.** `needs_review` exists because the regex binary lane INFERS a symbol from text in the bundle, and a human decides whether the match is real. The control lane does not infer — it reads the subtype's name off the CLI's own declarations, so existence is established by the artifact. What stays uncertain is the DATE, which `first_seen_estimated` already carries.

## Data contract

- JSON under `data/` is the **single source of truth**. YAML/TOML are generated in CI — never hand-edit them (they are gitignored).
- Every record must validate against `schema/symbol.schema.json`. CI runs `npm run validate` on every PR and blocks merge on failure.
- `first_seen` means _first observed_, not _first existed_ — don't assert an earlier version than you can support from an official source.

## Local checks before opening a PR

```bash
npm ci
npm run lint
npx prettier --check .   # CI fails on formatting; generated data is excluded
npx tsc --noEmit
npm test
npm run validate
```

`prettier --check` reads the working tree while CI reads the commit, so format
before you stage, not after.

## Workflow

- **Branch from a freshly fetched `main`.** Never commit to `main` directly, including
  one-line fixes. A stale base shows the PR as behind and forces a rebase later.
- **Every PR targets `main`.** Stacked PRs tangle review order and make the diff
  misleading.
- **Conventional commits.** The history is uniformly
  `type(scope): subject` — `feat(binary)`, `fix(settings)`, `docs`, `chore(data)`,
  `test(build-catalog)`. Nothing enforces this; please match it anyway.
- **Reasoning goes in the commit message**, not the PR body. A maintainer digging into
  a specific change will find it there. Keep PR descriptions short.
- **Never mix a code change with a dataset regeneration.** A re-extract touches ~800
  files and review tooling refuses PRs that large, so the one thing that needed review
  is the one thing that cannot get it. Code PR first, data PR second — see
  [the runbook](docs/runbooks/regenerating-the-dataset.md#splitting-the-prs).

`main` requires linear history and squash merges, and blocks merge until the
`validate` and security checks pass.

## Where things are documented

- [Architecture](docs/ARCHITECTURE.md) — the three lanes, the script map, and the
  invariants an extractor change has to hold. Read this before changing extraction.
- [Regenerating the dataset](docs/runbooks/regenerating-the-dataset.md) — the lane
  order, and the reconciliation that has to happen first.
- [Publishing](docs/runbooks/publishing.md) — how the site deploys.
- [CHANGELOG](CHANGELOG.md) — **if your change alters what a consumer can observe**
  (a new or changed field, a new endpoint, changed semantics), add an entry. Internal
  changes do not need one.

## Licensing of contributions

By contributing, you agree your contributions are licensed under the project's licenses: **Apache-2.0** for code (per its Section 5) and **CC-BY-4.0** for data under `data/`. Don't submit material you can't license this way — and per the provenance policy above, never submit anything derived from non-public/leaked sources.

## Adding a symbol by hand (rare)

Most data is generated by the scraper. If you must add a record manually, match the schema exactly, set an honest `provenance`/`confidence`, cite a `source_url` for changelog entries (or `null` for binary finds), and run the checks above.
