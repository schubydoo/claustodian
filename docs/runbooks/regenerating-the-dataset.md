# Runbook — regenerating the dataset

Rebuilding `data/` from the three lanes. For _why_ the steps are in this order, see
[ARCHITECTURE](../ARCHITECTURE.md#why-the-regeneration-order-is-what-it-is).

**Who can run this:** a maintainer with the local binary archive. Steps 2–4 work
without it; step 1 does not.

**Cost:** roughly 24 minutes of machine time for a full re-extract, plus review.

That is up from ~11 minutes: the control lane now runs in the same loop, and for the
compiled era each artifact is sliced before it is parsed.

⚠️ **The figure is derived, not measured end to end, and it is a floor.** The ~13
minutes is a two-point fit of PARSE time (13.0 MiB → 2.0 s, 22.9 MiB → 3.1 s) applied
to the 470 archived bundles, whose mean is 10.4 MiB. It predates the slicer and does
not include it: slicing costs roughly a further 0.8–1.1 s per compiled artifact
(measured at 2.1.113 and 2.1.226), which over the 98 compiled versions is about
another 1.5 minutes. Re-measure on the first real run and replace this whole
paragraph with the number.

---

## Before you start: reconcile the three version sets

They disagree, and the disagreement is silent.

| Set                   | What it is                          |
| --------------------- | ----------------------------------- |
| `scratch/binaries/`   | the local archive (maintainer-only) |
| `binary-cache/*.json` | committed per-version extractions   |
| changelog `## X.Y.Z`  | announced releases                  |

**`reextract-binaries` reads only the archive, and clears the cache first** — see
`clearCache()` in `scripts/reextract-binaries.ts`. A version present in
`binary-cache/` but missing from the archive is therefore **deleted**, and the run
still reports success.

This is not hypothetical. On the 2.1.224 run, 2.1.222/223/224 were in the cache but
not the archive because CI's `scrape-binary` had written them; a plain re-extract
would have destroyed exactly the versions that mattered. 2.1.221 was in the changelog
and in neither — never captured. Filling it corrected 7 symbols' `first_seen`.

Run the check:

```bash
bash scripts/check-version-sets.sh
```

Fetch anything missing (checksum-verified):

```bash
npm run scrape-binary -- --version 2.1.221 --force
```

**Eight versions genuinely 404 on the CDN** and cannot be filled: `0.2.21`, `0.2.26`,
`0.2.63`, `0.2.75`, `0.2.82`, `1.0.97`, `2.1.43`, `2.1.46`. Re-confirm rather than
assuming — the check script lists them separately.

> If you compare the sets by hand, use `sort`, **not** `sort -V`, before `comm`.
> `comm` needs lexicographic input and silently mis-diffs otherwise.

---

## The order

**Step 1 can now fail without failing loudly on its own terms.** The control lane
refuses a bundle it cannot parse, or one at or above 1.0.45 that yields no control
requests, rather than writing a zero. `reextract-binaries` collects those refusals,
writes NO cache entry for the affected versions, prints each one, and **exits 1**.
Do not run step 2 after a non-zero exit: the cache is incomplete, and a missing
version reads downstream as a removal.

You do not have to remember that. `binary-cache/_cache-incomplete.json` is a dirty flag:
`reextract-binaries` raises it BEFORE it clears the cache and lowers it only after writing
every version, and `backfill-binary` refuses while it exists — so step 2 stops itself.

The ordering is deliberate. The cache is incomplete from the moment it is cleared, so a
marker written only at the end would protect nothing against an interrupt, an out-of-memory
kill, or any throw outside the extraction loop. If you see this file, the cache is not usable. Read it — `status` says which of three
things happened, and each has a different way out:

| `status`      | What happened                             | How to clear it                                                                                        |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `in-progress` | The run was interrupted or died           | Re-run step 1                                                                                          |
| `refused`     | A lane refused a bundle it could not read | Fix the listed versions, then re-run step 1                                                            |
| `skipped`     | Versions were selected but never written  | Re-fetch each listed version with `npm run scrape-binary -- --version <v> --force`, then re-run step 1 |

⚠️ **`check-version-sets.sh` will not tell you about a `skipped` cache.** It reports a
version present in the archive but absent from the cache as benign `INFO` — "a re-extract
will pick these up" — which it cannot know is false when a re-extract just failed to. A
clean run of that script is not evidence this is resolved; the marker's absence is.

The file is `_`-prefixed so the next run preserves it and the backfill does not mistake it
for an extraction.

```bash
npm run reextract-binaries   # 1. archive      -> binary-cache/
npm run backfill-binary      # 2. binary-cache -> data/binary-observations.json
npm run fetch-docs           # 3. docs pages   -> data/docs.json
npm run scrape -- --all      # 4. everything   -> data/versions/, index, latest
```

Step 3 must come after step 2. `fetch-docs` resolves settings-page key paths against
`data/binary-observations.json`, because the docs group keys by topic rather than by
JSON nesting — a "Permission settings" table can list a key the schema holds flat.
Run the docs lane first and it resolves against a stale schema without complaining.

Skip step 1 if you are not changing extraction; skip steps 1–2 if you are only
refreshing docs.

---

## Verify before opening anything

```bash
npm run validate     # every data file against the schema
npm test
npm run coverage     # changelog coverage, informational
```

Then prove reproducibility — **re-run the same regeneration and confirm zero diff**:

```bash
npm run scrape -- --all && git diff --stat data/
```

Any output here means the pipeline is not deterministic. Fix that before proceeding;
a non-reproducible dataset cannot be reviewed.

---

## Splitting the PRs

**Never ship code and regenerated data together.** A full re-extract touches ~800
files (`binary-cache/` plus `data/versions/`). Greptile refuses to review any PR over
**500 files**, and the cap counts every file — `.greptile` exclusions do not reduce
it. Bury a logic change in a regeneration and the one thing that needed review is the
one thing that cannot get it.

1. **Code PR first** — extractor/lane logic and tests, `data/` untouched. Small
   enough to review.
2. **Data PR second**, branched from a `main` that already has the code. State the
   merge order in the body.
3. If the regeneration itself exceeds 500 files, split again: `binary-cache/` first,
   then `data/`. CI has no cross-check between them, so the halves are safe apart.

Regeneration is ~24 minutes. Review is worth more than the 24 minutes.

---

## Verifying an extractor change

A green suite is not evidence — see
[ARCHITECTURE](../ARCHITECTURE.md#why-a-green-test-suite-is-not-enough) for two rules
that passed their tests and were still wrong.

- Diff the new output against the committed `binary-cache/<version>.json` and read the
  added symbols one by one.
- Sweep several eras (`0.2.50` → tip), not just the tip. That is how you learn whether
  a change is surgical or era-wide.
- Run the real binary. `~/.local/share/claude/versions/<version>` is a plaintext
  bundle and can be read directly — no CDN download needed.

---

## If something goes wrong

| Symptom                                    | Cause                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Versions vanished from `binary-cache/`     | They were cache-only; the archive did not have them. Restore and re-fetch.            |
| A settings key published at the wrong path | Docs lane ran before the binary lane, or the key is topic-grouped.                    |
| Snapshots differ on a second identical run | Non-determinism. Do not commit; investigate.                                          |
| Symbol counts dropped across many versions | An extractor rule stopped matching. Diff a single era before assuming a real removal. |
