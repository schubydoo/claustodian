// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Symbol scoping — which subcommands a flag is accepted under.
 *
 * The dataset is a flat namespace, so a flag valid only under `claude plugin` has
 * been indistinguishable from one valid on bare `claude`. A consumer asking "does
 * 2.1.224 accept `--sandbox`?" gets yes, and then `claude --sandbox` fails,
 * because the flag belongs to `claude remote-control`.
 *
 * SEMANTICS. `scopes` is the COMPLETE set of subcommands a flag is accepted
 * under. Present and non-empty therefore also means "not accepted on bare
 * `claude`". Absent means no scope information — NOT "top-level", since most of
 * the dataset has never been audited for this.
 *
 * Completeness is what makes the field safe, and it is why this is a curated map
 * rather than a per-page rule in the docs lane. Deriving scope from the doc page a
 * symbol happened to be parsed from produces partial and sometimes plainly wrong
 * answers: `--help` is attributed to `plugins-reference` purely because no earlier
 * page claimed it, and scoping by page would publish "`--help` only works under
 * `claude plugin`" — worse than the flat namespace it replaces. `--all`, `--json`,
 * `--config` and `--yes` are each accepted under two or more different
 * subcommands, so a single page also cannot describe them.
 *
 * SOURCE. An exhaustive sweep of `claude <path> --help` at 2.1.226, the same
 * first-party `help` evidence PROMOTED_BINARY_SYMBOLS already uses for
 * descriptions, reading the `Options:` block of every invocation the help output
 * itself names. The walk now recurses to whatever depth the binary goes rather
 * than stopping at a fixed one; at 2.1.226 that bottoms out at depth three —
 * `plugin eval init` and `plugin marketplace {add,list,remove,update}`, the only
 * five, with no depth four. Anything the bare `claude --help` accepts (65 flags)
 * is excluded, since a flag valid top-level must stay unscoped: a non-empty list
 * asserts the opposite.
 *
 * The first capture stopped at depth two and so missed all five, which cost four
 * entries: `--interactive` (`plugin eval init`), `--json`
 * (`plugin marketplace list`) and `--scope` (`plugin marketplace add`,
 * `plugin marketplace remove`) each published an INCOMPLETE list — a false "no"
 * on a real invocation, since completeness is the whole contract — and `--sparse`
 * was absent. Depth is therefore a property to re-derive, not to assume: run
 * `claude <path> --help` down to exhaustion and stop when a level names no
 * further commands.
 *
 * ⚠️ A HIDDEN flag defeats the exclusion rule, and silently. The rule reads
 * "accepted by bare `claude --help`", but a flag registered with `.hideHelp()`
 * never appears there, so it is never excluded — and if some subcommand also
 * accepts a flag of that name, it acquires that subcommand as its COMPLETE scope
 * and the record then asserts it is invalid on bare `claude`. `--remote` was
 * exactly this: hidden top-level since 1.0.68 as a deprecated alias for `--cloud`
 * (the 2.1.226 bundle tests `t==="--cloud"||…||t==="--remote"` in top-level
 * argv), documented that way on the official `cli-reference` page, yet published
 * as `['plugin tag']` from `claude plugin tag --remote <name>`. It carries no
 * scope now. A help sweep CANNOT find this class — the flag is invisible to it by
 * construction — so cross-check the table against the top-level flags the docs
 * lane parses and against `hidden_eras` in data/binary-observations.json.
 * `--interview` is the same hidden shape without the harm: `.hideHelp()` on the
 * `plugin eval init` handler, so the sweep missed it but nothing false shipped.
 *
 * Five entries the sweep cannot reach are carried over from the 2.1.202 capture.
 * The four `remote-control` ones come from the official docs page —
 * `claude remote-control --help` refuses to print its flags unless signed in with
 * an eligible account — and `--base-dir` from `self-hosted-runner`, which is
 * argv-dispatched and hidden from `claude --help` so it is never enumerated. The
 * binary lane reaches that surface instead (scripts/argv-scopes.ts) and its
 * scopes UNION with this table, because either half can hold a path the other
 * cannot reach. `--capacity` is the case that proves it: this table has
 * `remote-control` alone, from the docs page named above, while the binary lane
 * proves `self-hosted-runner` and never sees a commander registration. They can
 * also simply agree — both record `--base-dir` as `self-hosted-runner`.
 *
 * POINT IN TIME. Like the help-sourced descriptions, this is a capture, not
 * something CI re-derives, and it is applied to every version. Scope changes
 * rarely, but a flag that moved between subcommands would be described by its
 * current home across its whole history. That trade is deliberate: a stale scope
 * is far less misleading than no scope at all, which reads as "top-level". Note
 * the binary lane does NOT make this trade — it records when it saw each parser
 * and bounds its scopes to those versions.
 */

/**
 * Curated `cli_flag` scopes. Keyed by flag; values are sorted and complete.
 *
 * Values are FULL INVOCATION PATHS after `claude` — `plugin eval`, `mcp add`,
 * not `plugin` or `mcp`. The first capture recorded the top-level subcommand
 * only, which turned out to be a false claim rather than a coarse one: commander
 * rejects a sub-subcommand's flag at the parent, so `claude plugin --scaffold`
 * answers `error: unknown option '--scaffold'` while the dataset said
 * `['plugin']`. That is the same error `scopes` exists to prevent, one level
 * down, and it also matches how the binary lane states runner scopes
 * (`self-hosted-runner orchestrator`), so the field now has one granularity
 * throughout.
 *
 * Re-deriving also fixed INCOMPLETENESS, which coarseness had hidden: `--scope`
 * is accepted under ten invocations across `mcp` and `plugin`, `--json` under
 * five including `auth status`, and `--all` under `project purge` — none of
 * which a single `plugin` entry could express. Twelve flags the first sweep
 * missed entirely (`--client-secret`, `--callback-port`, `--sso`, …) are here
 * because sub-subcommand help was never read.
 */
export const SYMBOL_SCOPES: ReadonlyMap<string, readonly string[]> = new Map([
  ['--ablation', ['plugin eval']],
  // `respawn` is from the background-subcommand parser, not the 2.1.226 help
  // sweep: `claude respawn <id>|--all` accepts `--all`, proved by
  // `extractBgSubcommandScopes` (scripts/argv-scopes.ts). It is curated here rather
  // than published from the binary lane because `--all` is a commander
  // registration elsewhere, and backfill-binary withholds binary scopes from a
  // strong-evidence flag; curation UNIONS, which is the only safe direction.
  ['--all', ['agents', 'plugin disable', 'project purge', 'respawn']],
  ['--allow-tools', ['plugin eval']],
  ['--author', ['plugin init']],
  ['--author-email', ['plugin init']],
  ['--available', ['plugin list']],
  ['--base-dir', ['self-hosted-runner']],
  ['--callback-port', ['mcp add']],
  ['--capacity', ['remote-control']],
  ['--case', ['plugin eval']],
  ['--claudeai', ['auth login']],
  ['--client-id', ['mcp add']],
  ['--client-secret', ['mcp add', 'mcp add-json']],
  ['--config', ['gateway', 'plugin install']],
  ['--console', ['auth login']],
  ['--cwd', ['agents']],
  ['--description', ['plugin init']],
  ['--dry-run', ['import', 'plugin prune', 'plugin tag', 'project purge']],
  ['--email', ['auth login']],
  ['--env', ['mcp add']],
  ['--force', ['install', 'plugin init', 'plugin tag']],
  ['--header', ['mcp add']],
  ['--interactive', ['plugin eval init', 'project purge']],
  ['--interview', ['plugin eval init']],
  [
    '--json',
    [
      'agents',
      'auth status',
      'plugin eval',
      'plugin list',
      'plugin marketplace list',
      'ultrareview',
    ],
  ],
  ['--judge-model', ['plugin eval']],
  ['--keep-data', ['plugin uninstall']],
  ['--keep-temp', ['plugin eval']],
  ['--label', ['auto-mode defaults']],
  ['--max-cost-usd', ['plugin eval']],
  ['--message', ['plugin tag']],
  ['--no-browser', ['mcp login']],
  ['--no-publish', ['plugin eval']],
  ['--no-sandbox', ['remote-control']],
  ['--no-scaffold', ['plugin eval']],
  ['--output-dir', ['plugin eval']],
  ['--prune', ['plugin uninstall']],
  ['--publish-report', ['plugin eval']],
  ['--push', ['plugin tag']],
  ['--report', ['plugin eval']],
  ['--runs', ['plugin eval']],
  ['--sandbox', ['remote-control']],
  ['--scaffold', ['plugin eval']],
  [
    '--scope',
    [
      'mcp add',
      'mcp add-from-claude-desktop',
      'mcp add-json',
      'mcp remove',
      'plugin disable',
      'plugin enable',
      'plugin install',
      'plugin marketplace add',
      'plugin marketplace remove',
      'plugin prune',
      'plugin uninstall',
      'plugin update',
    ],
  ],
  ['--sparse', ['plugin marketplace add']],
  ['--spawn', ['remote-control']],
  ['--sso', ['auth login']],
  ['--strict', ['plugin validate']],
  ['--tag', ['plugin eval']],
  ['--text', ['auth status']],
  ['--threshold', ['plugin eval']],
  ['--timeout', ['ultrareview']],
  ['--transport', ['mcp add']],
  ['--with', ['plugin init']],
  ['--yes', ['auto-mode reset', 'import', 'plugin prune', 'plugin uninstall', 'project purge']],
]);

/**
 * The scopes for a symbol, or undefined when it has none recorded.
 *
 * Only `cli_flag` is scoped. Commands are their own surface, env vars are read
 * from the environment regardless of subcommand, and settings keys live in a
 * file — none of them have a subcommand to be valid under.
 *
 * `binaryScopes` are the paths scripts/argv-scopes.ts proved from a bundle's own
 * usage banners. They UNION with the curated table rather than replacing it,
 * because each source sees a surface the other cannot: the `claude --help` sweep
 * cannot reach `self-hosted-runner` (argv-dispatched and hidden from help), and
 * the binary lane only sees hand-rolled argv switches, never a commander
 * registration. Where they overlap they agree — `--base-dir` is
 * `['self-hosted-runner']` from both — and where they do not, the union is the
 * more complete answer: the sweep recorded `--capacity` as `remote-control` only
 * because the runner's copy was invisible to it, and completeness is precisely
 * what this field asserts.
 */
export function scopesFor(
  type: string,
  symbol: string,
  binaryScopes?: readonly string[]
): readonly string[] | undefined {
  if (type !== 'cli_flag') return undefined;
  const curated = SYMBOL_SCOPES.get(symbol);
  if (!binaryScopes?.length) return curated;
  if (!curated) return [...binaryScopes].sort();
  return [...new Set([...curated, ...binaryScopes])].sort();
}
