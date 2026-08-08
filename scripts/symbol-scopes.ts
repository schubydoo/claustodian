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
 * descriptions. Every top-level subcommand was enumerated AND every
 * sub-subcommand of each (depth two — `plugin eval`, `mcp add`,
 * `plugin marketplace add`, `auth login`, …), reading the `Options:` block of
 * each. Anything the bare `claude --help` accepts (65 flags) is excluded, since a
 * flag valid top-level must stay unscoped: a non-empty list asserts the opposite.
 *
 * Five entries the sweep cannot reach are carried over from the 2.1.202 capture.
 * The four `remote-control` ones come from the official docs page —
 * `claude remote-control --help` refuses to print its flags unless signed in with
 * an eligible account — and `--base-dir` from `self-hosted-runner`, which is
 * argv-dispatched and hidden from `claude --help` so it is never enumerated. The
 * binary lane reaches that surface instead (scripts/argv-scopes.ts) and its
 * scopes UNION with this table; where both speak they agree.
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
  ['--all', ['agents', 'plugin disable', 'project purge']],
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
  ['--interactive', ['project purge']],
  ['--json', ['agents', 'auth status', 'plugin eval', 'plugin list', 'ultrareview']],
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
  ['--remote', ['plugin tag']],
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
      'plugin prune',
      'plugin uninstall',
      'plugin update',
    ],
  ],
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
