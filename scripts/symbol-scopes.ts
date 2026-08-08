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
 * SOURCE. An exhaustive sweep of `claude <subcommand> --help` at 2.1.202, the
 * same first-party `help` evidence PROMOTED_BINARY_SYMBOLS already uses for
 * descriptions. Every top-level subcommand was enumerated, plus every
 * `claude plugin` sub-subcommand, and anything bare `claude --help` accepts was
 * excluded. The four `remote-control` entries come from the official
 * remote-control docs page instead: `claude remote-control --help` refuses to
 * print its flags unless signed in with an eligible account.
 *
 * POINT IN TIME. Like the help-sourced descriptions, this is a capture, not
 * something CI re-derives, and it is applied to every version. Scope changes
 * rarely, but a flag that moved between subcommands would be described by its
 * current home across its whole history. That trade is deliberate: a stale scope
 * is far less misleading than no scope at all, which currently reads as
 * "top-level".
 */

/** Curated `cli_flag` scopes. Keyed by flag; values are sorted and complete. */
export const SYMBOL_SCOPES: ReadonlyMap<string, readonly string[]> = new Map([
  // `claude remote-control` server mode — from the official docs page.
  ['--capacity', ['remote-control']],
  ['--no-sandbox', ['remote-control']],
  ['--sandbox', ['remote-control']],
  ['--spawn', ['remote-control']],
  // Accepted under more than one subcommand — the case a single scope cannot describe.
  ['--all', ['agents', 'plugin']],
  ['--config', ['gateway', 'plugin']],
  ['--dry-run', ['import', 'plugin']],
  ['--force', ['install', 'plugin']],
  ['--json', ['agents', 'plugin', 'ultrareview']],
  ['--yes', ['import', 'plugin']],
  // `claude agents`
  ['--cwd', ['agents']],
  // `claude mcp`
  ['--header', ['mcp']],
  ['--transport', ['mcp']],
  // `claude ultrareview`
  ['--timeout', ['ultrareview']],
  // `claude plugin` and its sub-subcommands
  ['--ablation', ['plugin']],
  ['--allow-tools', ['plugin']],
  ['--author', ['plugin']],
  ['--author-email', ['plugin']],
  ['--available', ['plugin']],
  ['--case', ['plugin']],
  ['--description', ['plugin']],
  ['--judge-model', ['plugin']],
  ['--keep-data', ['plugin']],
  ['--keep-temp', ['plugin']],
  ['--max-cost-usd', ['plugin']],
  ['--message', ['plugin']],
  ['--no-publish', ['plugin']],
  ['--no-scaffold', ['plugin']],
  ['--output-dir', ['plugin']],
  ['--prune', ['plugin']],
  ['--publish-report', ['plugin']],
  ['--push', ['plugin']],
  ['--remote', ['plugin']],
  ['--report', ['plugin']],
  ['--runs', ['plugin']],
  ['--scaffold', ['plugin']],
  ['--scope', ['plugin']],
  ['--strict', ['plugin']],
  ['--tag', ['plugin']],
  ['--threshold', ['plugin']],
  ['--with', ['plugin']],
]);

/**
 * The scopes for a symbol, or undefined when it has none recorded.
 *
 * Only `cli_flag` is scoped. Commands are their own surface, env vars are read
 * from the environment regardless of subcommand, and settings keys live in a
 * file — none of them have a subcommand to be valid under.
 */
export function scopesFor(type: string, symbol: string): readonly string[] | undefined {
  if (type !== 'cli_flag') return undefined;
  return SYMBOL_SCOPES.get(symbol);
}
