// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Binary lane — policy. The curated interpretation of the raw binary evidence
 * in `data/binary-observations.json` (produced by `scripts/backfill-binary.ts`):
 * which binary-only env vars are Claude Code's own, how to categorize them, and
 * the type/guard for the observations file. The overlay itself
 * (`enrichWithBinary`) lives with the other lane merges in `scrape-changelog.ts`;
 * this module is the docs-lane's `assertOfficialDocs`/`DocsIndex` analogue.
 *
 * Why an allowlist for env vars. The extractor proves a symbol only when Claude
 * Code's own code reads `process.env.X` — but "CC reads it" is not "CC owns it"
 * (CC reads PATH and SSH_AUTH_SOCK too). So a binary-only env var is published
 * only when it is affirmatively first-party: a CLAUDE_/ANTHROPIC_-prefixed var
 * (categorizer says "claude-code"), or one of the two human-audited lists below.
 * Everything else — OS/shell standards, bundled-dependency knobs, third-party
 * cloud/CI detection — is left unpublished by omission. This is the conservative,
 * provenance-clean default: publication requires a positive first-party signal,
 * never mere observation. Flags and commands need no such list — the extractor's
 * registration/registry evidence already proves those are CC's own.
 *
 * The two lists are a point-in-time human audit (see scratch/audit-buckets.md).
 * A new binary-only env var in a future release that matches neither the prefix
 * nor a list falls through unpublished until a maintainer reviews and adds it —
 * by design, since these are undocumented symbols with no authoritative source.
 */
import { readFile } from 'node:fs/promises';
import { compareVersionsAsc, type ExtractedSymbolType } from './lib.js';
import { settingsKeyCategory } from './settings-schema.js';

/** A change point in a flag's `--help` visibility. */
export interface HiddenEra {
  from: string;
  hidden: boolean;
}

/** A symbol's observation window across the archived binaries. */
export interface BinaryObservation {
  symbol: string;
  type: ExtractedSymbolType;
  first_seen: string;
  last_seen: string;
  /**
   * Version where the symbol cleanly disappeared from the binaries, if the
   * evidence is trustworthy (see computeBinaryRemoval); null otherwise. Absence
   * in the recall-unreliable era (>= RELIABLE_EXTRACTION_CEILING) never sets this.
   */
  removed_in: string | null;
  /**
   * True when EVERY version that observed this symbol proved it only by a
   * `case"--flag":` label in a hand-rolled argv parser. Observed, recorded, and
   * deliberately not published — see isPublishableBinaryFlag. Absent means the
   * symbol has stronger evidence somewhere and publishes normally.
   */
  switch_case_only?: true;
  /**
   * For a `switch_case_only` flag: the complete set of invocation paths whose
   * argv parsers accept it, unioned across every version that observed it.
   * Evidence, not policy — the bundle's own `Usage: claude <path>` banner proved
   * each entry (see scripts/argv-scopes.ts). Absent when no version could
   * establish a complete scope, which is what keeps the flag withheld.
   */
  scopes?: readonly string[];
  /**
   * When the flag was registered with commander's `.hideHelp()`, as change
   * points: each era holds from its `from` version until the next. A TIMELINE
   * rather than a single flag because visibility moves — `--teleport` was hidden
   * through 2.1.220 and public at 2.1.226, `--task-budget` the same at 2.1.220 —
   * and one latest-state value would stamp today's answer on every historical
   * snapshot. Absent when the flag was never hidden.
   */
  hidden_eras?: readonly HiddenEra[];
}

export interface BinaryObservations {
  $generated_by: string;
  source: string;
  note: string;
  observedVersions: string[];
  symbols: BinaryObservation[];
}

/** The exact `$generated_by` / `source` a backfill-binary-produced file carries. */
const GENERATED_BY = 'scripts/backfill-binary.ts';
const SOURCE = 'binary';

/**
 * promote-cc (57) — unprefixed env vars that are unambiguously Claude Code's own
 * feature toggles (CC branches on them); they only skip the `CLAUDE_CODE_`
 * convention. Published as `provenance:binary` / `status:needs_review` and
 * recategorized to `claude-code`. Audited in scratch/audit-buckets.md.
 */
export const PROMOTE_CC_ENV: ReadonlySet<string> = new Set([
  'ANALYTICS_LOG_TOOL_DETAILS',
  'API_MAX_INPUT_TOKENS',
  'API_TARGET_INPUT_TOKENS',
  'AUTOMODE_DECISION_LOG',
  'DEBUG_CLAUDE_AGENT_SDK',
  'DEBUG_SDK',
  'DETAILED_PERMISSION_MESSAGES',
  'EMBEDDED_SEARCH_TOOLS',
  'DISABLE_AUTO_MIGRATE_TO_NATIVE',
  'DISABLE_BATCH_TOOL',
  'DISABLE_BRIEF_MODE_STOP_HOOK',
  'DISABLE_BUG_COMMAND',
  'DISABLE_CLAUDE_CODE_SM_COMPACT',
  'DISABLE_MICROCOMPACT',
  'DISABLE_MIGRATE_INSTALLER_COMMAND',
  'DISABLE_NON_ESSENTIAL_MODEL_CALLS',
  'ENABLE_BACKGROUND_TASKS',
  'ENABLE_BASH_ENV_VAR_MATCHING',
  'ENABLE_BASH_WRAPPER_MATCHING',
  'ENABLE_BETA_TRACING_DETAILED',
  'ENABLE_CLAUDE_CODE_SM_COMPACT',
  'ENABLE_CODE_GUIDE_SUBAGENT',
  'ENABLE_ENHANCED_TELEMETRY_BETA',
  'ENABLE_EXPERIMENTAL_MCP_CLI',
  'ENABLE_IDE_INTEGRATION',
  'ENABLE_INCREMENTAL_TUI',
  'ENABLE_LSP_TOOL',
  'ENABLE_MCP_CLI',
  'ENABLE_MCP_CLI_ENDPOINT',
  'ENABLE_MCP_LARGE_OUTPUT_FILES',
  'ENABLE_OVERFLOW_TEST_TOOL',
  'ENABLE_PLUGINS',
  'ENABLE_RELEASE_CHANNELS',
  'ENABLE_SESSION_PERSISTENCE',
  'ENABLE_STRUCTURED_OUTPUT',
  'ENABLE_TOOL_RESULT_SIZE_LIMIT',
  'FORCE_AUTO_BACKGROUND_TASKS',
  'FORCE_CODE_TERMINAL',
  'MCP_OAUTH_CLIENT_METADATA_URL',
  'MCP_SSE_AUTH_ENABLED',
  'MCP_TRUNCATION_PROMPT_OVERRIDE',
  'MCP_XAA_IDP_CLIENT_SECRET',
  'PERMISSION_EXPLAINER_ENABLED',
  'PERSIST_OAUTH_TOKENS',
  'RIPGREP_EMBEDDED',
  'RIPGREP_NODE_PATH',
  'SDK_NATIVE_BIN',
  'STRICT_ALLOWED_TOOLS',
  'THINK_TOOL',
  'USE_API_CLEAR_TOOL_RESULTS',
  'USE_API_CLEAR_TOOL_USES',
  'USE_API_CONTEXT_MANAGEMENT',
  'USE_HAIKU_SESSION_MEMORY',
  'USE_LOCAL_OAUTH',
  'USE_MCP_CLI_DIR',
  'USE_STAGING_OAUTH',
  'USE_TEST_OAUTH',
]);

/**
 * needs-review (35) — genuinely ambiguous binary-only env vars. Published as
 * `needs_review` and kept at their natural category (NOT recategorized), so a
 * human confirms ownership before any of them is treated as confirmed. Some lean
 * external on a closer look (BAT_THEME=bat pager, INK_SCREEN_READER=ink TUI,
 * TELEPORT_*=Teleport proxy). Audited in scratch/audit-buckets.md.
 */
export const NEEDS_REVIEW_ENV: ReadonlySet<string> = new Set([
  'AGENT_PROXY_AUTH_TOKEN',
  'AGENT_PROXY_URL',
  'AUDIO_CAPTURE_NODE_PATH',
  'BAT_THEME',
  'BETA_TRACING_ENDPOINT',
  'BUGHUNTER_DEV_BUNDLE_B64',
  'BUGHUNTER_FLEET_SIZE',
  'CCR_EGRESS_GATEWAY_ENABLED',
  'CCR_ENABLE_BUNDLE',
  'CCR_SPAWN_TIMESTAMP_MS',
  'CCR_UPSTREAM_PROXY_ENABLED',
  'CLAUBBIT',
  'COMPUTER_USE_INPUT_NODE_PATH',
  'COMPUTER_USE_SWIFT_NODE_PATH',
  'DEBUG_AUTH',
  'DEV',
  'DS_CHROMIUM_PATH',
  'DS_VALIDATE_CAP_SECONDS',
  'INK_SCREEN_READER',
  'IS_SANDBOX',
  'LOCAL_BRIDGE',
  'MODIFIERS_NODE_PATH',
  'REVIEW_REMOTE',
  'SCREENSHOT_DIR',
  'SESSION_INGRESS_URL',
  'SPACE_CREATOR_USER_ID',
  'SRT_DEBUG',
  'SRT_WIN_PATH',
  'TEAM_MEMORY_SYNC_URL',
  'TELEPORT_HEADERS',
  'TELEPORT_RESUME_URL',
  'TEST_ENABLE_SESSION_PERSISTENCE',
  'URL_HANDLER_NODE_PATH',
  'VERBOSE_SSR',
  'VOICE_STREAM_BASE_URL',
]);

/**
 * True when a binary-only env var is affirmatively Claude Code's own and may be
 * published: a `claude-code`-categorized (CLAUDE_/ANTHROPIC_) var, or one of the
 * audited promote-cc / needs-review lists. `category` is the categorizer's result
 * for the symbol. Everything else is left unpublished by omission.
 */
export function isPublishableBinaryEnv(symbol: string, category: string): boolean {
  return category === 'claude-code' || PROMOTE_CC_ENV.has(symbol) || NEEDS_REVIEW_ENV.has(symbol);
}

/**
 * True when an accessor-map getter key may be treated as an env var at all.
 *
 * NARROWER than isPublishableBinaryEnv, and the difference is the point. The two
 * predicates answer different questions:
 *
 *   publication  — given this IS an env var, is it Claude Code's own?
 *   accessor gate — is this ALL-CAPS getter key an env var in the first place?
 *
 * The getter shape (`NAME:()=>ref`) does not prove a `process.env` read; ~43% of
 * raw matches are ordinary constants (`NEVER`, `BROWSER_TOOLS`,
 * `NUMBER_FORMAT_RANGES`). So admission needs positive evidence that the NAME is
 * an env var, and only two things supply it: the CLAUDE_/ANTHROPIC_ convention,
 * or PROMOTE_CC_ENV, whose audit states these are Claude Code's own feature
 * toggles that merely skip the convention.
 *
 * NEEDS_REVIEW_ENV is deliberately excluded. That list is "ownership unresolved,
 * some lean external on a closer look" (BAT_THEME is bat's, INK_SCREEN_READER is
 * ink's, TELEPORT_* is Teleport's) — it cannot serve as the evidence that a
 * same-named getter key is an env var rather than a constant. Those names still
 * publish when the direct `process.env.X` path proves them, which is the stronger
 * signal and the one the audit was performed over.
 */
export function isAccessorEvidenceEnv(symbol: string, category: string): boolean {
  return category === 'claude-code' || PROMOTE_CC_ENV.has(symbol);
}

/**
 * True when a binary-observed flag may be published. The gate is scope, not
 * ownership: a `case"--flag":` label proves the flag is Claude Code's own, but it
 * only ever appears in a hand-rolled parser for a SUBCOMMAND — at 2.1.224 all 44
 * such flags belong to `claude self-hosted-runner` or deeper (`--verify` is
 * `self-hosted-runner decode-token`), and not one is valid on bare `claude`.
 *
 * The dataset is a flat namespace, so publishing them would assert that
 * `claude --verify` works, which it does not. They stay in
 * `data/binary-observations.json` as recorded evidence and out of the published
 * per-version answer — the same observe-but-withhold posture
 * isPublishableBinaryEnv takes for env vars Claude Code merely reads.
 *
 * That holding position is now lifted for the flags whose scope IS known. The
 * schema gained `scopes` (a complete set of invocation paths), and
 * extractSwitchCaseScopes proves each one from the parser module's own
 * `Usage: claude <path>` banner, so those flags publish with their owning command
 * instead of being dropped. A switch-case flag with no established scope stays
 * withheld exactly as before — that is every such flag before 2.1.224, and
 * `--help`, whose scope cannot be complete because the `/plugin` slash-command
 * parser also switches on it.
 */
export function isPublishableBinaryFlag(observation: BinaryObservation): boolean {
  return observation.switch_case_only !== true || (observation.scopes?.length ?? 0) > 0;
}

/**
 * True when a binary observation may move an EXISTING record's `first_seen`.
 *
 * Deliberately stricter than isPublishableBinaryFlag, and not folded into it. A
 * scoped flag now publishes, but its dates describe the SUBCOMMAND's flag, and
 * identity here is `type:symbol` with no room for the distinction: `--capacity`
 * is one record covering both `claude remote-control --capacity` (docs, older)
 * and `claude self-hosted-runner --capacity` (2.1.224). Letting the runner
 * sighting re-date that record would answer "when did --capacity appear?" with
 * the wrong event. The same argument the withholding gate used to make about
 * `--help` applies to every scoped flag, so it outlives the gate.
 */
export function mayRedateFromBinary(observation: BinaryObservation): boolean {
  return observation.switch_case_only !== true;
}

/**
 * The published category for a flag: `cli-internal` when the CLI hides it from
 * `claude --help`, `cli` otherwise.
 *
 * `.hideHelp()` is Claude Code's own statement that a flag is real but not
 * user-facing: it parses and works, yet something else sets it — a spawning
 * parent (`--managed-settings`, "SDK use only"), the teammate orchestrator
 * (`--agent-id`, `--team-name`), a deep link, or a deprecated alias kept for
 * compatibility. Verified against 2.1.226: every hidden flag is absent from
 * `claude --help` yet accepted on the command line, and no public flag carries
 * the marker.
 *
 * CATEGORY, not type or status — the same call settingsKeyCategory makes for
 * `@internal` keys. The flag exists and works, so status stays whatever the
 * evidence says; hiding is a property of how it is surfaced, and it moves when
 * Anthropic promotes a flag out of hiding.
 */
export function binaryFlagCategory(
  eras: readonly HiddenEra[] | undefined,
  version: string,
  category: string
): string {
  return hiddenAt(eras, version) ? 'cli-internal' : category;
}

/**
 * Whether the flag was hidden at `version` — the latest era whose `from` is
 * <= version. False before the first era, which is the honest answer: we have no
 * observation of it being hidden that early, and distillation drops a leading
 * public era as information-free.
 */
export function hiddenAt(eras: readonly HiddenEra[] | undefined, version: string): boolean {
  let state = false;
  for (const era of eras ?? []) {
    if (compareVersionsAsc(era.from, version) > 0) break;
    state = era.hidden;
  }
  return state;
}

/**
 * The published category for a binary-only env var: promote-cc vars become
 * `claude-code`; everything else keeps the categorizer's result (CLAUDE_/ANTHROPIC_
 * vars are already `claude-code`; needs-review vars stay at their natural category).
 */
export function binaryEnvCategory(symbol: string, category: string): string {
  return PROMOTE_CC_ENV.has(symbol) ? 'claude-code' : category;
}

/**
 * Audit promotions — binary-only symbols a maintainer has reviewed and confirmed
 * are genuine, user-facing Claude Code symbols, so they graduate from the
 * conservative `status:needs_review` default to `status:active` with a first-party
 * description. `provenance` stays `binary` (the binary is still what established
 * existence); only the lifecycle status and description are added by the audit.
 *
 * Keyed `type:symbol`. Two first-party description sources:
 *  - `binary` — the command/skill registry description the extractor already reads
 *    out of the bundle (`{type,name,description}` / skill `menuDescription`).
 *  - `help` — the symbol's own `claude --help` output at 2.1.202 (an in-range
 *    installed release; the CLI's own help text is first-party). Like
 *    `data/binary-observations.json`, these are a point-in-time maintainer capture
 *    reviewed in the PR, not something CI re-derives (the --help lane isn't built).
 *
 * The audit worksheet is scratch/needs-review-audit.{md,csv}. Everything NOT in
 * this map stays `needs_review` by omission — promotion requires a positive human
 * call, never mere observation.
 */
export interface BinaryPromotion {
  description: string;
  description_source: 'binary' | 'help';
}

export const PROMOTED_BINARY_SYMBOLS: ReadonlyMap<string, BinaryPromotion> = new Map<
  string,
  BinaryPromotion
>([
  [
    'command:/rate-limit-options',
    { description: 'Show options when rate limit is reached', description_source: 'binary' },
  ],
  [
    'command:/pro-trial-expired',
    {
      description: 'Options shown when the Pro plan Claude Code trial has ended',
      description_source: 'binary',
    },
  ],
  [
    'command:/update-config',
    {
      description: 'Change settings: hooks, permissions, environment variables',
      description_source: 'binary',
    },
  ],
  [
    'command:/design',
    {
      description: 'Grant or revoke Claude agent access to your Design projects',
      description_source: 'binary',
    },
  ],
  [
    'command:/design-consent',
    {
      description: 'Grant Claude agent access to your Design projects',
      description_source: 'binary',
    },
  ],
  [
    'command:/design-revoke',
    {
      description: 'Revoke Claude agent access to your Design projects',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--ablation',
    {
      description:
        'Run a no-plugin baseline arm and report the score delta (none | with-without; default: with-without when targeting a plugin by name (installed or skills-dir), none for a path)',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--allow-tools',
    {
      description:
        'Operator grant for gated tools (Bash, Write, Edit, WebFetch, mcp__*). Supports Tool(pattern:*) syntax',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--allowed-tools',
    {
      description: 'Comma or space-separated list of tool names to allow (e.g. "Bash(git *) Edit")',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--brief',
    {
      description: 'Enable SendUserMessage tool for agent-to-user communication',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--callback-port',
    {
      description:
        'Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs)',
      description_source: 'help',
    },
  ],
  ['cli_flag:--case', { description: 'Filter cases by name glob', description_source: 'help' }],
  [
    'cli_flag:--claudeai',
    { description: 'Use Claude subscription (default)', description_source: 'help' },
  ],
  [
    'cli_flag:--config',
    {
      description:
        "Set a userConfig option declared in the plugin's manifest (repeatable). Values are validated against the schema and stored via the same path as the interactive /plugin configure flow.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--cwd',
    {
      description: 'Show only background sessions started under <path>',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--disallowed-tools',
    {
      description: 'Comma or space-separated list of tool names to deny (e.g. "Bash(git *) Edit")',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--email',
    { description: 'Pre-populate email address on the login page', description_source: 'help' },
  ],
  [
    'cli_flag:--env',
    { description: 'Set environment variables (e.g. -e KEY=value)', description_source: 'help' },
  ],
  [
    'cli_flag:--file',
    {
      description:
        'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--header',
    {
      description: 'Set WebSocket headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--interactive',
    { description: 'Prompt for each item before deleting', description_source: 'help' },
  ],
  [
    'cli_flag:--judge-model',
    { description: 'Override LLM-grader model (default: haiku)', description_source: 'help' },
  ],
  [
    'cli_flag:--keep-temp',
    { description: 'Preserve scaffold dirs for debugging', description_source: 'help' },
  ],
  [
    'cli_flag:--max-cost-usd',
    {
      description:
        'Optional hard cost ceiling; abort and report partial results if hit (exit 2). Overrun is bounded to one agent run — when that run breaches, paid graders (llm/baseline) are skipped while free graders still score it. Runs are already bounded by max_turns and timeout_seconds — only set this when you need a strict budget',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--message',
    { description: 'Tag annotation message (use %s for the version)', description_source: 'help' },
  ],
  [
    'cli_flag:--no-scaffold',
    { description: 'Explicitly skip scaffold_script', description_source: 'help' },
  ],
  [
    'cli_flag:--output-dir',
    {
      description: 'Directory for aggregate-result.json (default: ./evals/results/<timestamp>/)',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--runs',
    { description: 'Override per-case runs (default: case.runs ?? 3)', description_source: 'help' },
  ],
  [
    'cli_flag:--scaffold',
    {
      description:
        "Run each case's scaffold_script (runs author-supplied bash as you; off by default — only use on case files you authored)",
      description_source: 'help',
    },
  ],
  ['cli_flag:--sso', { description: 'Force SSO login flow', description_source: 'help' }],
  [
    'cli_flag:--strict',
    {
      description:
        'Treat warnings as errors (exit 1). Use in CI to fail on unrecognized fields, missing metadata, and other issues that the runtime tolerates.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--tag',
    { description: 'Filter cases by tag (repeatable)', description_source: 'help' },
  ],
  ['cli_flag:--text', { description: 'Output as human-readable text', description_source: 'help' }],
  [
    'cli_flag:--threshold',
    {
      description: 'Exit 1 if any case score is below this threshold (default: 1.0)',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--timeout',
    {
      description: 'Maximum minutes to wait for the review to finish (default: 30)',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--transport',
    {
      description: 'Transport type (stdio, sse, http). Defaults to stdio if not specified.',
      description_source: 'help',
    },
  ],
  // Every remaining flag the CLI hides from `claude --help` that carries its own
  // registered description. Same evidence bar as any other promotion — Anthropic
  // wrote the text and the CLI accepts the flag — and `category: cli-internal`
  // already tells a reader not to type it, so `active` cannot be misread as
  // "user-facing". `--plugin-dir-no-mcp` is excluded: hidden, but no description
  // to promote.
  [
    'cli_flag:--correlation-id',
    {
      description:
        'Opaque id echoed back to the environment orchestrator on the work order (requires --environment).',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--cowork',
    { description: 'Use cowork_plugins directory', description_source: 'binary' },
  ],
  [
    'cli_flag:--debug-to-stderr',
    { description: '(deprecated) Enable debug mode (to stderr)', description_source: 'binary' },
  ],
  [
    'cli_flag:--deep-link-cwd-b64',
    {
      description: 'Base64url-encoded working directory (deep-link shell-safe launch paths)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--deep-link-last-fetch',
    {
      description: 'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--deep-link-origin',
    {
      description: 'Signal that this session was launched from a deep link',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--deep-link-repo',
    {
      description: 'Repo slug the deep link ?repo= parameter resolved to the current cwd',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--enable-auth-status',
    { description: 'Enable auth status messages in SDK mode', description_source: 'binary' },
  ],
  [
    'cli_flag:--interview',
    { description: 'Alias for --interactive', description_source: 'binary' },
  ],
  [
    'cli_flag:--managed-settings',
    {
      description: 'Policy-tier settings JSON from a spawning parent process (SDK use only)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--max-thinking-tokens',
    {
      description:
        '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--messaging-socket-path',
    {
      description:
        'Cross-session messaging server path: a Unix domain socket on Mac/Linux, a \\\\.\\pipe\\ name on Windows (defaults to an auto-generated path)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--on-branch',
    {
      description:
        'Work directly on <branch> in the remote session (checkout and push to it). On self-hosted environments this includes pushing to the default branch when it is not protected — use GitHub branch protection to restrict. Mutually exclusive with --ref. Requires --cloud or --environment.',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--parent-session-id',
    { description: 'Parent session ID for analytics correlation', description_source: 'binary' },
  ],
  [
    'cli_flag:--plan-mode-instructions',
    {
      description:
        'Custom workflow body for plan mode. Replaces the default code-implementation phases in the plan-mode system reminder; the read-only enforcement preamble and ExitPlanMode protocol footer are always kept.',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--plan-mode-required',
    { description: 'Require plan mode before implementation', description_source: 'binary' },
  ],
  [
    'cli_flag:--pool',
    { description: 'Deprecated alias for --environment', description_source: 'binary' },
  ],
  [
    'cli_flag:--prefill',
    {
      description: 'Pre-fill the prompt input with text without submitting it',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--prefill-b64',
    {
      description: 'Base64url-encoded --prefill value (deep-link shell-safe launch paths)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--reply-on-resume',
    {
      description:
        'When resuming, immediately query if the loaded transcript ends in a user-role message (set by /background mid-turn so the fork continues the in-flight turn).',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--resume-drops-turn',
    {
      description:
        'With --resume-session-at in print mode: declare the prompt uuid of the turn the truncating resume intends to discard; the resume is refused if the discarded range contains anything not attributable to that turn (absorbed queued messages, task notifications, content from other turns). Ignored outside print mode, like --resume-session-at.',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--resume-session-at',
    {
      description:
        "When resuming, only messages up to and including the chain entry with <message.id> — any chain-entry UUID, typically the kept turn's last entry (use with --resume in print mode)",
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--rewind-files',
    {
      description:
        'Restore files to state at the specified user message and exit (requires --resume)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--sdk-url',
    {
      description:
        'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--session-mirror',
    {
      description:
        'Emit transcript_mirror frames on stdout (SDK-internal; set by ProcessTransport when sessionStore is configured)',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--team-name',
    { description: 'Team name for teammate coordination', description_source: 'binary' },
  ],
  [
    'cli_flag:--thinking',
    {
      description: 'Thinking mode: enabled (equivalent to adaptive), disabled',
      description_source: 'binary',
    },
  ],
  [
    'cli_flag:--thinking-display',
    { description: 'How thinking content appears in the response', description_source: 'binary' },
  ],
  [
    'cli_flag:--workload',
    {
      description:
        'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)',
      description_source: 'binary',
    },
  ],
  // Agent-team orchestration flags. Claude Code sets these when it spawns a
  // teammate session; typing one yourself parses but does nothing useful. They
  // are commander-registered with these exact descriptions, so the text is the
  // binary's own — the "do not type this" signal is carried by
  // `category: cli-internal` (from .hideHelp()), not by prose invented here.
  //
  // `--agent-teams` is deliberately absent: it is a feature GATE read as
  // `process.argv.includes("--agent-teams")` alongside
  // CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, not a teammate parameter, and it
  // carries no description to promote.
  ['cli_flag:--agent-id', { description: 'Teammate agent ID', description_source: 'binary' }],
  ['cli_flag:--agent-name', { description: 'Teammate display name', description_source: 'binary' }],
  ['cli_flag:--agent-color', { description: 'Teammate UI color', description_source: 'binary' }],
  [
    'cli_flag:--agent-type',
    { description: 'Custom agent type for this teammate', description_source: 'binary' },
  ],
  // Four the ORIGINAL sweep missed for the same reason the scope map was wrong:
  // it read only `claude <subcommand> --help`, so `plugin eval` and
  // `auto-mode defaults` were never opened. Same 'help' evidence, just one level
  // deeper. Re-checking every remaining needs_review flag against the full
  // depth-two corpus turned up these and nothing else.
  [
    'cli_flag:--label',
    {
      description: 'Show only rules whose label starts with this prefix (case-insensitive)',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--no-publish',
    {
      description: 'Keep the HTML report local only; skip publishing it to claude.ai',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--publish-report',
    {
      description:
        'Also require publishing the report to claude.ai (already the default when your account supports it); explains why if unavailable',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--report',
    {
      description:
        'Write the self-contained HTML report (scores, prompts, grader verdicts) to <path> instead of the results dir',
      description_source: 'help',
    },
  ],
  // `claude self-hosted-runner` and its sub-subcommands, captured from
  // `self-hosted-runner --help`, `… orchestrator --help` and `… decode-token --help`
  // at 2.1.226. The subcommand is absent from `claude --help`'s command list, so the
  // sweep that built the other entries never reached it — but asking it directly
  // works, which is the only thing that matters for evidence.
  //
  // Six runner flags are deliberately NOT here and stay needs_review:
  //   --api-url / --health-port / --hooks-dir  differ in meaning per invocation
  //     (`--api-url` is the JWKS endpoint under decode-token, the control plane
  //     elsewhere), and identity is `type:symbol`, so one record cannot hold both.
  //     Same rule extractFlagDescriptions already applies to ambiguous specs.
  //   --pool-secret-file / --drain-wait-bg-tasks-sec  appear only in prose about the
  //     flag they alias, with no entry of their own to quote.
  //   --sigkill-timeout-sec  is accepted by the parser but absent from help entirely.
  [
    'cli_flag:--configure-git',
    {
      description:
        "Set global git identity to Claude <noreply@anthropic.com> and enable commit signing via Anthropic's signing service, matching 1P sessions. Writes ~/.gitconfig at runner startup. Without this flag, your image must provide its own git identity.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--confine-repo-settings',
    {
      description:
        'Repo-committed-settings confine guard mode: warn (default) logs a would-refuse diagnostic per violation and still spawns; enforce refuses to spawn the session; off disables the scan. Invalid values fail closed at startup.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--debug-dir',
    {
      description:
        'DEV ONLY — writes each work-order JWT + decoded JSON + hook stderr to <dir>/<jti>.{jwt,json,stderr}. Auto-pruned after 5m.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--debug-token-dir',
    {
      description: 'DEBUG ONLY — writes live tokens to disk. Do not use in production.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--drain-grace-sec',
    {
      description:
        "Default: 0 — exit immediately after active sessions finish, WITHOUT polling for more (one-shot when --capacity=1). Set a positive value (e.g. 30) to keep the runner warm and re-poll the locked account's queue for that many seconds before exiting. Max: 604800.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--drain-wait-sec',
    {
      description:
        "On SIGTERM/SIGINT, wait up to N seconds for each session's in-flight turn (a foreground tool call) and running background tasks to finish before sending the session process its SIGTERM. Adds N to the advertised shutdown budget. Default: 0 (send SIGTERM immediately). Max: 86400. (--drain-wait-bg-tasks-sec is a deprecated alias for this flag.)",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--environment-secret-file',
    {
      description:
        'Path to environment secret file (or set SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET) (--pool-secret-file / SELF_HOSTED_RUNNER_POOL_SECRET are deprecated aliases.)',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--exec-path',
    {
      description: "Binary to spawn for child sessions. Default: this process's own binary.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--exit-if-unused-min',
    {
      description:
        'Exit the runner if never assigned work for N min (autoscaler scale-down). Default: never. Max: 10080.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--expected-spawn-seconds',
    {
      description:
        "p99 boot time for runners this orchestrator spawns (default: 120). Sent on every Poll as the server-side lease; if the runner doesn't register before then, the session is re-hinted with a fresh jti. HA replicas MUST use the same value.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--git-host-rewrite',
    {
      description:
        'Rewrite https://<f>/... source URLs to https://<t>/... (repeatable). For split-horizon DNS where the runner reaches GHE via a different hostname than the control plane. Applied before --git-ssh-rewrite.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--git-ssh-rewrite',
    {
      description:
        'Rewrite https://<host>/... source URLs to git@<host>:... (repeatable). For SSH-only git hosts.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--hook-concurrency',
    {
      description:
        'Max spawn-runner hooks running in parallel (default: 4). Also caps how many hints are claimed per poll.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--hook-timeout',
    {
      description: 'SIGTERM the hook after <sec> seconds (default: 60).',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--kill-session-after-min',
    {
      description:
        'SIGTERM a session child after N min wall-clock (runaway backstop). If a turn is in flight at the deadline, the kill is deferred until the turn finishes, with a hard cap of 15 min past the deadline (override: SELF_HOSTED_RUNNER_MAX_LIFETIME_GRACE_MS, in ms). Default: never. Max: 10080.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--lock-to-account',
    {
      description:
        "Lock runner to a single account at registration (webhook-driven on-demand spawn). Only that account's sessions are assigned.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--log-file',
    {
      description: 'Tee runner logs to a file in append mode. Stdout is unchanged.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--log-level',
    { description: 'Log level: info or debug (default: info)', description_source: 'help' },
  ],
  [
    'cli_flag:--min-idle',
    {
      description:
        'Keep at least <n> idle slots free (free capacity across runners, not runner count; default: 0, disabled). The server mints standby work_orders (no session binding) for the gap on every Poll.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--no-check-expiry',
    {
      description:
        'Skip the exp/nbf check (signature still verified). For forensics ("was this token ever issued by us?").',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--no-verify',
    {
      description:
        'Skip signature verification and the JWKS fetch. For offline inspection only — do NOT feed the output to an auth decision.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--post-session-hook-timeout-sec',
    {
      description:
        'SIGTERM budget for the post-session lifecycle hook, on every session end including runner shutdown. Default: 60.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--push-outcome-on-release',
    {
      description:
        'On a runner-initiated non-completed session end (SIGTERM drain, idle-release, failed), push every tracked outcome branch to origin before deleting it, so in-flight commits survive a runner restart. Skipped on server-initiated deassign. On a resumed session (worker epoch > 1), the prep path fetches any previously pushed outcome branch from origin and continues from it, so histories stay linear. CAVEAT: the resume-fetch trusts refs/heads/<outcome-branch> on the source remote — anyone with push access to that ref can place content into the resumed workspace; if your source revision is protected but claude/* refs are not, that collaborator write surface widens on resume. Repos checked out via the checkout lifecycle hook are NOT pushed — use the post-session hook to snapshot those. Adds 30s (total, shared across all pushes) to the advertised shutdown budget.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--release-idle-session-min',
    {
      description:
        'Release a session slot after N min of no user input (turn finished, or parked at a permission prompt, user idle). Runner exits if this drops it to zero active sessions. Default: never. Max: 10080.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--retire-at',
    {
      description:
        "Retire the runner at the given wall-clock time (absolute Unix timestamp, in seconds): release every active session through the ReleaseSession path that --release-idle-session-min uses (the session parks server-side and a fresh runner picks it up on the user's next message), stop taking new work, and exit 0 once the slots are empty. A session still mid-turn at that time is released as soon as its turn ends; background work a finished turn left running gets up to 60s of grace, then the session parks anyway (perpetual monitor tasks don't hold it at all). Use this when the host hard-kills the runner at a known time (e.g. a sandbox lifetime cap): set it far enough before the kill to cover typical turns PLUS the per-session shutdown budget (--session-stop-grace-sec, the push-outcome window, the full --post-session-hook-timeout-sec, the 60s background-work grace, one poll) so sessions park cleanly and the post-session hook isn't truncated by the kill. Default: never.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--scm-connector-ca-file',
    { description: 'Extra CA bundle (PEM) for TLS to the GHES host.', description_source: 'help' },
  ],
  [
    'cli_flag:--scm-connector-host',
    {
      description:
        'GHES hostname to forward to (port defaults to 443). Setting this enables the connector.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--scm-connector-host-rewrite',
    {
      description:
        'e2e only — redirect the TCP connect while keeping Host/SNI as --scm-connector-host.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--scm-connector-id',
    {
      description: 'ghe_configurations.id for this org (REQUIRED with --scm-connector-host).',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--scm-connector-provider',
    { description: 'Provider slug (default: ghe).', description_source: 'help' },
  ],
  [
    'cli_flag:--session-stop-grace-sec',
    {
      description:
        'How long to wait for the Claude process to exit cleanly after a session ends, before force-killing it. The post-session hook runs after this. Default: 5.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--startup-timeout-min',
    {
      description:
        'Release a session slot if the child has not completed initialization N min after spawn — covers a child hung during --resume hydration or MCP connect, and a session assigned with no pending input. Cleared once the child emits system:init, after which --release-idle-session-min takes over. Default: 15. 0 disables. Max: 10080.',
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--trust-workspace',
    {
      description:
        "Seed persisted trust for each session's repo paths so repo-level .claude/settings.json permissions.allow and additionalDirectories are honored by the child. Default: true. Set to false for cli#44151's stricter gate: repo-committed grants are dropped with an \"Ignoring N permissions.allow\" stderr diagnostic; configure host-level grants via the host-config dir's settings.json permissions.allow (userSettings source) instead.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--use-anthropic-git-proxy',
    {
      description:
        "Clone via Anthropic's git proxy (uses the session creator's stored GitHub OAuth token, or the org's GitHub App installation token for bot/agent sessions; you don't manage git auth on the runner). Supersedes --git-host-rewrite and --git-ssh-rewrite.",
      description_source: 'help',
    },
  ],
  [
    'cli_flag:--verify',
    {
      description:
        "(Deprecated — verification is the default. Kept so older wrapper scripts don't break.)",
      description_source: 'help',
    },
  ],
]);

/** The audit promotion for a binary symbol, if a maintainer confirmed it. */
export function promotionFor(type: string, symbol: string): BinaryPromotion | undefined {
  return PROMOTED_BINARY_SYMBOLS.get(`${type}:${symbol}`);
}

/**
 * First version of the recall-unreliable era. The extractor's per-version recall
 * regressed here (bundle minification changed; env extraction dropped ~2.1.159→160
 * with no real deletions — see scratch/audit-buckets.md), so binary ABSENCE at or
 * after this version is not trustworthy. Removal detection only trusts absence in
 * the reliable era strictly before this ceiling.
 */
export const RELIABLE_EXTRACTION_CEILING = '2.1.160';

/** How many reliable-era absences after the last sighting we require before
 * trusting a disappearance (guards against a lone flicker right before the cliff). */
const REMOVAL_ABSENCE_MARGIN = 3;

/**
 * Infers `removed_in` for a binary-only symbol from its per-version presence —
 * conservatively, because the extractor's recall is imperfect and a lone missed
 * version must not read as a removal. Returns the version where the symbol
 * disappeared only when ALL hold, else null:
 *
 *  - the last sighting is in the RELIABLE era (< RELIABLE_EXTRACTION_CEILING), so
 *    the subsequent absence is corroborated by trustworthy extractions;
 *  - it was solidly present right before vanishing (>= 2 of the last 3 reliable
 *    versions up to the last sighting), so this is a real disappearance, not a
 *    low-recall flicker (the extractor misses some symbols most versions);
 *  - it then stayed absent across >= REMOVAL_ABSENCE_MARGIN reliable versions.
 *
 * removed_in is the first archived version after the last sighting — our best
 * evidence-bounded estimate of when it went (the true removal may fall between
 * archived versions).
 */
export function computeBinaryRemoval(
  presentVersions: readonly string[],
  observedVersions: readonly string[]
): string | null {
  if (presentVersions.length === 0) return null;
  const present = new Set(presentVersions);
  const asc = [...observedVersions].sort(compareVersionsAsc);
  const lastSeen = [...presentVersions].sort(compareVersionsAsc)[
    presentVersions.length - 1
  ] as string;

  // Only the reliable era carries a trustworthy absence signal.
  if (compareVersionsAsc(lastSeen, RELIABLE_EXTRACTION_CEILING) >= 0) return null;
  const reliable = asc.filter((v) => compareVersionsAsc(v, RELIABLE_EXTRACTION_CEILING) < 0);

  const reliableAfter = reliable.filter((v) => compareVersionsAsc(v, lastSeen) > 0);
  if (reliableAfter.length < REMOVAL_ABSENCE_MARGIN) return null;

  const lastThreeBefore = reliable.filter((v) => compareVersionsAsc(v, lastSeen) <= 0).slice(-3);
  const solidlyPresent =
    lastThreeBefore.length >= 2 && lastThreeBefore.filter((v) => present.has(v)).length >= 2;
  if (!solidlyPresent) return null;

  return asc.find((v) => compareVersionsAsc(v, lastSeen) > 0) ?? null;
}

/**
 * Loads `data/binary-observations.json`, the committed binary evidence file.
 * A missing/unreadable file throws with actionable guidance (it is a committed
 * build input, regenerated by `npm run backfill-binary`) rather than a bare
 * ENOENT — mirroring loadCacheFiles' self-diagnosing failure.
 */
export async function loadBinaryObservations(path: string): Promise<BinaryObservations> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    throw new Error(
      `Cannot read binary observations at ${path}: ${(error as Error).message}. ` +
        `It is a committed build input — regenerate it with "npm run backfill-binary" ` +
        `(requires the local binary cache; see scratch/backfill-notes.md).`,
      { cause: error }
    );
  }
  return JSON.parse(raw) as BinaryObservations;
}

/**
 * Integrity guard for the committed binary observations: it must be a non-empty,
 * backfill-binary-produced file. Catches a hand-edited or corrupted
 * `data/binary-observations.json` before its symbols are published as
 * `provenance:"binary"`, and — like `assertNonEmptyDocs` — a valid-but-empty file
 * that would silently drop the entire lane while validation still passes.
 */
export function assertBinaryObservations(obs: BinaryObservations, path: string): void {
  if (obs.$generated_by !== GENERATED_BY || obs.source !== SOURCE) {
    throw new Error(
      `Binary observations ${path} is not a scripts/backfill-binary.ts output ` +
        `(got $generated_by=${JSON.stringify(obs.$generated_by)}, source=${JSON.stringify(obs.source)}); ` +
        `refusing to publish it as provenance:"binary". Regenerate with "npm run backfill-binary".`
    );
  }
  if (!Array.isArray(obs.symbols)) {
    throw new Error(
      `Binary observations ${path} is malformed: "symbols" is not an array ` +
        `(the file was likely truncated or hand-edited). Regenerate with "npm run backfill-binary".`
    );
  }
  if (obs.symbols.length === 0) {
    throw new Error(
      `Binary observations ${path} has 0 symbols — the cache/archive was likely missing when it ` +
        `was generated. Rebuild the binary cache and re-run "npm run backfill-binary".`
    );
  }
}

/**
 * One era of a symbol's description: the text is in effect from version `from`
 * until the next era begins (or forever, if last). Distilled from the archived
 * binaries — see BinaryDescriptions.
 */
export interface DescriptionEra {
  from: string;
  description: string;
}

/**
 * Per-symbol description timeline extracted from the archived binaries. Fixes the
 * anachronism where one current `description` was stamped on every snapshot: the
 * command/skill registry description is captured per version and collapsed to
 * change-points (eras), so a snapshot can carry the description that symbol
 * actually had at that version. Keyed `${type}:${symbol}`; eras ascending by `from`.
 * First-party and version-stamped (the checksum-verified bundles), regenerated by
 * scripts/backfill-binary.ts — the same trust model as BinaryObservations, and NOT
 * self-referential (it reads the archive, never prior generated output).
 */
export interface BinaryDescriptions {
  $generated_by: string;
  source: string;
  note: string;
  descriptions: Record<string, DescriptionEra[]>;
}

/**
 * The published category for a binary-observed settings key.
 *
 * `settings-internal` is read off an `@internal` marker in the schema's own
 * description, so `categorize()` — which sees only a symbol name and a type —
 * cannot reconstruct it, and a config key would otherwise publish as plain
 * `settings` with its internal-ness silently dropped.
 *
 * Derived here rather than carried on the observation on purpose:
 * `data/binary-observations.json` is evidence, not interpretation (see the
 * "pure evidence out" contract in backfill-binary), and the description timeline
 * this reads is already policy input owned by this module. It also comes out
 * more accurate — the era in effect AT THAT VERSION, rather than one
 * newest-wins value smeared across a symbol's whole history.
 */
export function binaryConfigCategory(
  eras: readonly DescriptionEra[] | undefined,
  version: string
): 'settings' | 'settings-internal' {
  return settingsKeyCategory(eras ? descriptionAt(eras, version)?.description : undefined);
}

/**
 * The era in effect at `version` (the latest era whose `from` is <= version), or
 * undefined if the symbol had no description by then. `eras` must be ascending.
 */
export function descriptionAt(
  eras: readonly DescriptionEra[],
  version: string
): DescriptionEra | undefined {
  let active: DescriptionEra | undefined;
  for (const era of eras) {
    if (compareVersionsAsc(era.from, version) <= 0) active = era;
    else break;
  }
  return active;
}

/** True when `version` falls in the timeline's final (current) era. */
export function isCurrentDescriptionEra(eras: readonly DescriptionEra[], version: string): boolean {
  const last = eras[eras.length - 1];
  return last !== undefined && compareVersionsAsc(last.from, version) <= 0;
}

/** Loads `data/binary-descriptions.json`; self-diagnosing on a missing/unreadable file. */
export async function loadBinaryDescriptions(path: string): Promise<BinaryDescriptions> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    throw new Error(
      `Cannot read binary descriptions at ${path}: ${(error as Error).message}. ` +
        `It is a committed build input — regenerate it with "npm run backfill-binary" ` +
        `(requires the local binary cache; see scratch/backfill-notes.md).`,
      { cause: error }
    );
  }
  return JSON.parse(raw) as BinaryDescriptions;
}

/**
 * Integrity guard for the committed binary descriptions: a non-empty,
 * backfill-binary-produced file, mirroring assertBinaryObservations.
 */
export function assertBinaryDescriptions(desc: BinaryDescriptions, path: string): void {
  if (desc.$generated_by !== GENERATED_BY || desc.source !== SOURCE) {
    throw new Error(
      `Binary descriptions ${path} is not a scripts/backfill-binary.ts output ` +
        `(got $generated_by=${JSON.stringify(desc.$generated_by)}, source=${JSON.stringify(desc.source)}); ` +
        `refusing to use it. Regenerate with "npm run backfill-binary".`
    );
  }
  if (typeof desc.descriptions !== 'object' || desc.descriptions === null) {
    throw new Error(
      `Binary descriptions ${path} is malformed: "descriptions" is not an object ` +
        `(the file was likely truncated or hand-edited). Regenerate with "npm run backfill-binary".`
    );
  }
  // Validate each timeline's shape here, so a malformed entry fails with this
  // actionable message rather than crashing later in descriptionAt's iteration.
  for (const [key, eras] of Object.entries(desc.descriptions)) {
    if (!Array.isArray(eras)) {
      throw new Error(
        `Binary descriptions ${path} is malformed: entry ${JSON.stringify(key)} is not an ` +
          `array of eras. Regenerate with "npm run backfill-binary".`
      );
    }
    for (const era of eras) {
      if (typeof era?.from !== 'string' || typeof era?.description !== 'string') {
        throw new Error(
          `Binary descriptions ${path} is malformed: entry ${JSON.stringify(key)} has an era ` +
            `missing string from/description. Regenerate with "npm run backfill-binary".`
        );
      }
    }
  }
}
