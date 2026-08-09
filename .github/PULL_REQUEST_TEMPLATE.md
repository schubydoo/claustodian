<!--
Keep the description short. Reasoning belongs in the commit message, where a
maintainer digging into a specific change will find it.
-->

## What changed and why

## Verification

<!-- What you ran, and what it showed. "Tests pass" on its own is not evidence. -->

---

- [ ] `npm run lint`, `npx prettier --check .`, `npx tsc --noEmit`, `npm test` and
      `npm run validate` all pass locally
- [ ] Data under `data/` is **generated**, not hand-edited
- [ ] This PR does **not** mix code changes with a dataset regeneration — see
      [the runbook](../docs/runbooks/regenerating-the-dataset.md#splitting-the-prs)
- [ ] Any new symbol traces to an official public Anthropic artifact
- [ ] An extractor change was checked against a real binary, not only unit tests
