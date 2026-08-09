# CLAUDE.md

**The shared instructions for this repo live in [AGENTS.md](AGENTS.md): commands, the
architecture map, hard rules, and workflow preferences. The line below imports it, so
it loads with this file — you do not need to open it separately. This file adds only
what is specific to Claude Code.**

@AGENTS.md

Keeping the shared rules in one file is deliberate. A second copy drifts on the next
change, and stale instructions are worse than none.

⚠️ **That `@AGENTS.md` line is load-bearing — do not "tidy" it into a plain link.**
Claude Code reads `CLAUDE.md`, not `AGENTS.md`; a markdown link is a suggestion an
agent may or may not follow, while `@` is an import expanded into context at launch.
Note `@` is inert inside backticks or a code fence, so `` `@AGENTS.md` `` in prose
does **not** import.

---

## Local overrides

`CLAUDE.local.md` is gitignored and loads _after_ this file. Host-specific paths,
personal tooling preferences, and machine operational notes belong there — not here.
If you find yourself adding something to this file that would only be true on one
machine, it goes in `CLAUDE.local.md` instead.

`.claude/` and `scratch/` are also gitignored. Do not assume anything in them exists,
and do not reference them from committed files — a contributor without them would read
a broken pointer.

---

## Working in this repo

- **Before proposing a PR**, run the same gates CI does: `npm run lint`,
  `npx prettier --check .`, `npx tsc --noEmit`, `npm test`, `npm run validate`.
  Formatting is a merge gate, and `prettier --check` reads the working tree while CI
  reads the commit — format before you stage, not after.
- **Changing an extractor?** The tests will pass and still be wrong. Diff the output
  against the committed `binary-cache/<version>.json`, read the added symbols one by
  one, and sweep several eras rather than the tip alone. The installed binary at
  `~/.local/share/claude/versions/<version>` is a plaintext bundle you can read
  directly.
- **Before believing a clean result**, prove the instrument can fail. A detector that
  has never produced a positive tells you nothing when it returns nothing.
- **When delegating to a subagent**, pass the verification requirement explicitly. A
  sweep that trusts doc prose will report stale status as fact.

## Data changes

`data/` is generated. A PR that hand-edits it is wrong even if the values are right,
because the next regeneration silently reverts them.

Regenerating touches ~800 files, so it never rides along with a code change — see the
hard rules in AGENTS.md and
[the runbook](docs/runbooks/regenerating-the-dataset.md).
