# Claude review instructions

Rules for the on-demand Claude reviewer (`.github/workflows/claude-review.yml`).

**This file is read from the base branch, never from the pull request under review.**
A PR therefore cannot edit the rules that govern its own review. Keep it that way: do
not make the workflow read these instructions from the PR head.

Tune the reviewer by editing **this file** — a normal PR. Do not move these rules into
the workflow YAML: `claude-code-action` refuses to run when the workflow file differs
from the copy on the default branch, so instructions living in the YAML could only be
changed by merging a new workflow every time.

Length has a cost. Rules that change review behaviour belong here; general project
context belongs in `AGENTS.md` / `CLAUDE.md`, which the reviewer already reads.

---

## What this project is

Claustodian is a static, versioned dataset of the Claude Code surface — every CLI flag,
environment variable, command, settings key and stream-json control message, tagged with
the version it was first observed in. Three lanes (changelog, docs, release binaries) produce one JSON snapshot
per release.

**The whole value is that every claim is checkable against something Anthropic
published.** A record asserted without evidence is worse than a missing record, because
a wrong date is indistinguishable from a right one to anyone reading the site.

That changes what "correct" means here. A change can be tidier, faster and better
factored and still be wrong, because it made the dataset assert something the evidence
does not support.

## Severity

- **🔴 Important** — asserts a symbol without positive evidence, breaks the record
  contract, corrupts a date, or violates an invariant below. Fix before merge.
- **🟡 Nit** — real but minor. Worth saying, never blocking.
- **🟣 Pre-existing** — a genuine bug this PR did not introduce. At most two per review,
  never Important; this project fixes those in their own PR.

Style, naming, and refactoring suggestions are **Nit at most**, always.

## Always check

A change that breaks one of these is wrong even if every test passes:

1. **Positive evidence only.** A symbol may be asserted only when the bundle, the
   changelog or the docs _prove_ it. When an extractor meets a construct it does not
   recognise it must **throw** — a silent skip reads downstream as a removal. Any new
   admission path needs the PR to say what proves membership, not what filters
   non-members out. A denylist is the wrong shape: it admits whatever the next release
   invents.
2. **Absence is not removal.** An extractor returning nothing, a version missing from
   the archive, and a symbol genuinely deleted must not be able to look alike. Guard
   anything that could report zero: a sweep over an unreadable input must fail loudly.
3. **Identity is `type:symbol`, and never derived from mutable text.** A change that
   makes identity depend on a description, a category or any other field that can vary
   by release is Important.
4. **A field that can vary by version needs a timeline AND a resolver returning an
   absolute value.** Never fall back to the record's current value — that backfills
   today's answer into history, which is the exact failure the dataset exists to avoid.
5. **Never hand-edit `data/`, or the `.yaml`/`.toml` exports.** They are generated; the
   next regeneration silently reverts them, so a hand-fix is a change that disappears.
   Never run a formatter over generated data either — `binary-cache` is single-line JSON
   and prettier breaks the zero-diff check.
6. **Never a code change and a dataset regeneration in the same PR.** A re-extract
   touches ~800 files and Greptile refuses to review anything over 500, so the one thing
   that needed review is the one thing that cannot get it. Code PR first, data PR second.
7. **Lane order is load-bearing, not alphabetical.** `fetch-docs` resolves settings-key
   paths against `data/binary-observations.json`, so the binary lane must land first or
   the docs lane resolves against a stale schema.
8. **`reextract-binaries` clears `binary-cache/` and reads only the archive.** A version
   present in the cache but absent from the archive is destroyed by a run that reports
   success.

## Extractor changes need more than a green suite

**Every extractor defect in this project passed its tests.** Treat these as Important:

1. **A new or changed extraction rule needs a before/after diff against the committed
   `binary-cache/<version>.json`**, with the added symbols read one by one. If the PR
   does not say it did this, say so.
2. **One version is not a sweep.** A rule tuned on the tip can be silently era-wide or
   silently inert. Several eras, not just the newest release.
3. **Look-back and look-ahead windows over minified text are the recurring trap.** A
   `new X("--flag"` look-back once matched an Error message string; a `case"--flag":`
   rule was sound but every flag it found was subcommand-scoped. Both passed review-free
   unit tests.
4. **Never anchor on a minified identifier.** Builder and helper names churn every few
   releases (`QH` → `De` → `Pe`). Anchor on shape. A rule tuned on one build that
   returns zero on another is a bug, not a removal.
5. **A test that cannot fail is worse than no test.** A new test must fail without its
   fix; if the PR does not say it checked, that is a finding.

## Do not report

CI already enforces these on every PR, and paying a reviewer to re-find them is waste:

- Formatting, lint, unused names — `eslint`, `prettier --check`
- Type errors — `tsc --noEmit`
- Schema conformance of `data/` — `npm run validate`
- Missing coverage as a bare observation — the **95%** statements threshold in
  `vitest.config.ts` and Codecov patch coverage report it precisely
- Hardcoded-secret shapes — `gitleaks`
- Known-CVE dependencies — Trivy, `dependency-review`, OSV-Scanner
- Generic OWASP checklist items with no call site in the diff — CodeQL
- Unpinned GitHub Actions — `zizmor` (blanket hash-pin policy)

Also do not report: anything in `CHANGELOG.md`, generated files under `data/`, or an
issue explicitly silenced by a lint-ignore comment.

## Review independently

You may be the second opinion or the only one, depending on whether Greptile reviewed.

- **Do not read other reviewers' comments on the PR** before forming your findings. The
  workflow already hides Greptile and Codecov from your context; do not go looking.
- A finding is not more credible because another tool raised it, nor less because it
  didn't.
- The one exception is your **own** previous review on the same PR — read that, and
  reconcile against it per the re-review rules below.

## Verification bar

Every finding must be checkable from the code, not inferred from a name.

- A claim about behaviour needs a `file:line` citation of the code that causes it.
- If confirming a finding needs context outside the diff, read that context first. If
  you still cannot confirm it, do not post it.
- Do not flag anything whose failure depends on state you have not shown to be
  reachable.
- **A status line in a doc, a TODO or a comment is a cache, not truth.** Do not raise a
  finding whose only evidence is prose claiming something is done.

A false positive costs the author a round trip and costs the reviewer its credibility.
When uncertain, say nothing.

### Do not run the test suite, the extractors, or a regeneration

**Reviewing is a reading job here.** Do not attempt `npm test`, `npm run scrape`,
`npm run validate` or any extraction script.

CI runs lint, format, types, the full suite and schema validation on every push, for
free. More to the point, the instruments this project actually relies on are **not
available to you**: the release-binary archive lives in gitignored `scratch/` (472
releases, ~175 GB) and `binary-cache/` diffs need it, so a differential measurement is
not something this runner can perform.

When a PR asserts a measured extraction result:

- Check that the change _could_ produce it — read the code, the fixture, the assertion.
- Say what you verified and how. "Verified by reading; the before/after diff quoted in
  the PR body is the measurement" is a complete answer, not an apology.
- Do **not** frame the absence of a local run as a limitation. It is the design.

Attempting it anyway is worse than useless: the calls are denied, and the workflow reads
a non-zero denial count as a signal the review was blocked from _publishing_ — so
routine denials train that warning to be ignored.

## Volume

At most **five Nits** per review. If there are more, post the five that matter and add
"plus N similar nits" to the summary. There is no cap on Important findings.

## Re-reviews

When the PR has been reviewed before, open with a `## Previous findings` section and
resolve every prior Important finding as exactly one of:

- **FIXED** — cite the line or commit that addressed it
- **ACCEPTED** — quote the author's technical justification and say why it resolves the
  concern. "Please approve" or "this is fine" is **not** a technical justification
- **STILL OPEN** — not addressed by code or explanation

A finding marked FIXED or ACCEPTED is closed. Do not re-raise it. After the first
review, post **Important findings only** — suppress new Nits entirely, so a one-line fix
cannot reach round seven on style.

## Output

- Post every line-specific finding as an **inline comment**, and group them into
  **exactly one submitted review**. Do not submit a separate review per finding: each
  inline comment becomes a thread the maintainer replies to and resolves, and one grouped
  review is the difference between one pass over the PR and several.
- Put the **summary table** — every finding with its file and line — in the **body of the
  submitted review**, and nowhere else. That table is what makes the review readable
  without opening the diff, and what survives inline anchors going stale.
- **Do not repeat the findings anywhere else.** Your final message becomes the progress
  comment at the top of the PR; keep it to the checklist, a one-line verdict, and a
  pointer to the review.
- Submit as a **COMMENT** review. Never `REQUEST_CHANGES`, never `APPROVE` — this
  reviewer is advisory and must not gate a merge.
- Do not number findings `#1`, `#2`. GitHub turns a hash plus digits into a link to an
  unrelated issue. Use "Finding 1" or a short description.
- Link code with the **full** SHA and a line range with a line of context either side:
  `https://github.com/schubydoo/claustodian/blob/<full-sha>/scripts/binary-lane.ts#L40-L46`
- Lead the summary with a one-line tally, e.g. `2 important, 3 nits`, and say "No
  important findings" plainly when that is the case.
- Use a committable `suggestion` block only when committing it fixes the issue
  **entirely**. If follow-up work is needed, describe the fix instead.
