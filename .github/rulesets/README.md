# Repository rulesets (config-as-code)

These JSON files are the source of truth for this repo's [rulesets][rulesets].
GitHub does not apply them automatically — import them once through the UI, then
keep these files in sync when you change a rule.

## Files

| File        | Target         | What it enforces                                                                                                   |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `main.json` | default branch | No deletion / force-push, linear history, squash-only PRs with thread resolution, required checks, CodeQL scanning |
| `tags.json` | `v*` tags      | No deletion / force-push of release tags                                                                           |

## Required status checks (`main.json`)

Both contexts are produced by GitHub Actions (`integration_id: 15368`):

- **`validate`** — the job in `validate-pr.yml` (lint, typecheck, tests+coverage, schema + dataset validation).
- **`security required checks passed`** — the aggregator job in `security.yml` (CodeQL, gitleaks, zizmor, dependency-review).

The `code_scanning` rule additionally requires a current **CodeQL** analysis
(fed by `security.yml` on PRs and `codeql.yml` on head-SHA pushes).

> **Import order:** import `main.json` only _after_ a PR has run at least once, so
> GitHub knows the `validate` / `security required checks passed` contexts exist —
> otherwise the required-checks picker can't resolve them.

## Import

Settings → Rules → Rulesets → **New ruleset** → **Import a ruleset**, then select
the file. (The `id` / `source` fields present on a UI export are omitted here;
GitHub assigns them on import.)

[rulesets]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
