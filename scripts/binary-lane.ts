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
 * The published category for a binary-only env var: promote-cc vars become
 * `claude-code`; everything else keeps the categorizer's result (CLAUDE_/ANTHROPIC_
 * vars are already `claude-code`; needs-review vars stay at their natural category).
 */
export function binaryEnvCategory(symbol: string, category: string): string {
  return PROMOTE_CC_ENV.has(symbol) ? 'claude-code' : category;
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
  const lastSeen = [...presentVersions].sort(compareVersionsAsc)[presentVersions.length - 1] as string;

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
