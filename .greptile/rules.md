# Claustodian review rules

Claustodian is a **provenance-strict** dataset: every symbol record must be sourced only from
official, first-party, public Anthropic artifacts, and each record's `provenance`
(`changelog` | `docs` | `binary`) must reflect the lane it actually came from. Never ingest
leaked, source-map-derived, or otherwise non-public material. Question every "temporary"
workaround that has outlived its excuse.

> `.greptile/config.json` `ignorePatterns` already excludes `data/**`, `coverage/**`, and
> `dist/**` from review, so these rules apply to reviewed source (primarily `scripts/**`, plus
> `schema/**` where a rule concerns the symbol-record shape). Each rule states its own
> **Applies to**, since `rules.md` is global (no glob scope).

## Provenance boundary — the source, not the label

**Applies to:** `scripts/**`, `schema/**`

Ingested Anthropic data must originate ONLY from official, first-party, public lanes — the
changelog (`CHANGELOG.md`), the docs (`code.claude.com/docs`), or officially published release
binaries — and each record's `provenance` must be **derived from the source lane, never
hand-assigned**. The violation to catch is an **illegitimate source** (a non-official host, a
leak/source-map mirror, a gist, an unofficial API), not merely a mislabeled string.

**Good** — a lane bound to an official host; provenance derived from it:

```ts
const DOCS_HOST = "code.claude.com";
async function fetchDocsLane(url: URL) {
  if (url.hostname !== DOCS_HOST) throw new Error(`refusing non-official docs host: ${url.hostname}`);
  return { provenance: "docs" as const, symbols: parseDocs(await (await fetch(url)).text()) };
}
```

**Bad** — a non-first-party source, then a fabricated lane:

```ts
async function fetchFromMirror() {
  const res = await fetch("https://gist.githubusercontent.com/anon/leaked-claude-symbols.json"); // leak/source-map mirror
  return { provenance: "docs" as const, symbols: await res.json() };                             // not first-party at all
}
```

**Not a violation:** re-hashing an already-acquired official release binary against its committed
`SHA256SUMS` and stamping `provenance:"binary"` — see *Binary provenance* below.

## Generated data is the build's output, not a hand-edited file

**Applies to:** `scripts/**`, `schema/**`

Symbol data under `data/` is produced wholesale by `npm run scrape` from official sources. Code
must write `data/` only through the scraper/build pipeline; symbol changes belong in the scraper
or schema, never in a script that hand-constructs or patches a `data/` file. (Hand-edits to the
`data/` files themselves are caught by CI regenerate-and-diff — `data/**` is excluded from
review — so this rule guards the *code path* that would bypass the pipeline.)

**Good** — data written through the build's snapshot writer:

```ts
await writeJson(join(outDir, "latest.json"), toSnapshotFile(latestSnapshot));
```

**Bad** — hand-patching generated output, so `data/` no longer matches `npm run scrape`:

```ts
const latest = JSON.parse(readFileSync("data/latest.json", "utf8"));
latest.symbols.push({ symbol: "--new-flag", provenance: "changelog" });
writeFileSync("data/latest.json", JSON.stringify(latest, null, 2));
```

## CLI entrypoints are tested in-process

**Applies to:** `scripts/**/*.test.ts`

Tests for a CLI entrypoint must exercise it by calling its exported `main(argv)` in-process —
pass argv directly, use a temp dir — NOT by spawning the CLI under test as a subprocess (zero
v8 coverage credit, and it can hit the network). The repo's `main()` takes argv as a parameter
(`process.argv` is read only in the `isMain` block), so tests pass argv directly and never
mutate `process.argv`. This targets running the system under test only — using `child_process`
for *fixture setup* (e.g. `execFileSync('tar', …)` to build a test tarball) is fine.

**Good:**

```ts
import { main } from "./my-cli.js";
it("writes output when run in-process", async () => {
  const out = await mkdtemp(join(tmpdir(), "cli-"));
  expect(await main(["--out", out])).toBe(0);
  expect(existsSync(join(out, "result.json"))).toBe(true);
});
```

**Bad:**

```ts
import { execFileSync } from "node:child_process";
it("runs the CLI", () => {
  execFileSync("npx", ["tsx", "scripts/my-cli.ts", "--out", "./tmp"]); // subprocess SUT → no coverage
});
```

## Binary provenance — established at acquisition, not re-extraction

**Applies to:** `scripts/**`

Binary provenance is established ONCE, at acquisition: downloaded bundles are verified against
Anthropic's officially-published checksums (each release's `SHASUMS256.txt` and npm bundle
integrity), which are committed into the archive as per-version `SHA256SUMS`. Maintainer-local
tools that consume the archive (`reextract-binaries`, `backfill-binary`) may only RE-HASH
bundles against those committed `SHA256SUMS` as a local integrity check — they must **not**
re-fetch official checksums or re-download binaries over the network to "re-establish" trust
each run.

Do NOT flag these tools for "trusting a checksum file from the local archive": the archive's
`SHA256SUMS` **are** the official published sums, and `--archive`/`--out` are maintainer-supplied
local inputs, not untrusted external/network input, so supply-chain / path-injection threat
models that assume an external adversary controls those paths do not apply. DO flag a genuinely
new external/network ingestion path (e.g. fetching checksums or content from a non-official
host), anything that lets non-first-party content into `data/`, or blurring of which lane a
record came from.

**Good** — re-hash the local bundle against the archive's committed sums; refuse on mismatch:

```ts
function isOfficial(file: string, versionDir: string, relPath: string): boolean {
  const want = officialSha(versionDir, relPath); // parsed from <versionDir>/SHA256SUMS
  return want !== undefined && sha256(readFileSync(file)) === want;
}
if (!isOfficial(bundle, versionDir, relPath)) return { kind: "unverified", file: bundle };
```

**Bad** — re-establishing trust from an external source during a run:

```ts
const url = "https://example.com/SHASUMS256.txt"; // not first-party / not official
const expected = await (await fetch(url)).text();
assert(sha256OfBundle(bundlePath) === parseExpected(expected));
```
