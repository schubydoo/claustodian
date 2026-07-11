// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal zero-dependency client for the Claustodian dataset.
 *
 * Claustodian answers: "does a Claude Code symbol (CLI flag / env var / slash
 * command) exist in version Y, and what did it do at that version?" The data is
 * static JSON on GitHub Pages — this client just fetches it and applies the
 * three rules that matter (availability, removal=vanish, describe-at-version).
 *
 * Requires Node 18+ (global `fetch`). Run the demo:  npx tsx examples/claustodian.ts
 * The pure functions (compareSemver / availableAt / resolveEra) take already-loaded
 * data, so you can unit-test them without the network.
 */

export const DEFAULT_BASE = 'https://schubydoo.github.io/claustodian/data';

// All five values the schema's `type` enum allows. Only cli_flag/command/env_var
// appear in the data today; config_key/internal_config_flag are reserved by the
// schema, so a forward-compatible consumer should accept them too.
export type SymbolType = 'cli_flag' | 'command' | 'env_var' | 'config_key' | 'internal_config_flag';
export type Status = 'active' | 'deprecated' | 'needs_review';

export interface ClaudeSymbol {
  symbol: string;
  type: SymbolType;
  first_seen: string;
  removed_in: string | null;
  deprecated_in?: string;
  status: Status;
  provenance: 'changelog' | 'docs' | 'binary';
  confidence: 'high' | 'medium';
  first_seen_estimated?: boolean;
  description: string;
  description_source?: 'docs' | 'changelog' | 'binary' | 'help';
  source_url: string | null;
  category: string;
}

export interface Snapshot {
  claudeCodeVersion: string;
  schemaVersion: string;
  symbols: ClaudeSymbol[];
}

export interface Index {
  schemaVersion: string;
  latest: string;
  versions: string[];
}

/** Change-point era: a description that holds from `from` until the next era. */
export interface DescriptionEra {
  from: string;
  description: string;
}

/** Compare two `X.Y.Z` versions. Returns -1, 0, or 1 (semver order, not string). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Is `sym` available in `version`, judging only by its own fields?
 *   first_seen <= version AND (removed_in is null OR removed_in > version)
 * (The per-version snapshot already encodes this; use it when you hold one record.)
 */
export function availableAt(sym: ClaudeSymbol, version: string): boolean {
  if (compareSemver(sym.first_seen, version) > 0) return false;
  if (sym.removed_in && compareSemver(sym.removed_in, version) <= 0) return false;
  return true;
}

/** The description in effect at `version` from a change-point timeline, if any. */
export function resolveEra(timeline: DescriptionEra[], version: string): string | undefined {
  let current: string | undefined;
  for (const era of timeline) {
    if (compareSemver(era.from, version) <= 0) current = era.description;
    else break; // timeline is oldest-first; nothing past here applies
  }
  return current;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** The list of tracked versions (newest-first) plus the latest tag. */
export function fetchIndex(base = DEFAULT_BASE): Promise<Index> {
  return fetchJson<Index>(`${base}/index.json`);
}

/** Full symbol snapshot for a version, or the newest one when `version` is 'latest'. */
export function fetchSnapshot(version: string | 'latest', base = DEFAULT_BASE): Promise<Snapshot> {
  const path = version === 'latest' ? 'latest.json' : `versions/${version}.json`;
  return fetchJson<Snapshot>(`${base}/${path}`);
}

/** Look a symbol up by its exact token (e.g. "--output-format", "/init", "CLAUDE_CODE_SAFE_MODE"). */
export function findSymbol(snap: Snapshot, symbol: string): ClaudeSymbol | undefined {
  return snap.symbols.find((s) => s.symbol === symbol);
}

/** Description-at-version for one symbol, from `binary-descriptions.json` (key = "type:symbol"). */
export async function describeAt(
  type: SymbolType,
  symbol: string,
  version: string,
  base = DEFAULT_BASE
): Promise<string | undefined> {
  const doc = await fetchJson<{ descriptions: Record<string, DescriptionEra[]> }>(
    `${base}/binary-descriptions.json`
  );
  const timeline = doc.descriptions[`${type}:${symbol}`];
  return timeline ? resolveEra(timeline, version) : undefined;
}

// --- Demo: `npx tsx examples/claustodian.ts` ---------------------------------
async function main(): Promise<void> {
  const idx = await fetchIndex();
  console.log(`Claustodian schema ${idx.schemaVersion}, latest ${idx.latest}, ${idx.versions.length} versions tracked`);

  const latest = await fetchSnapshot('latest');
  const flag = findSymbol(latest, '--output-format');
  console.log(`--output-format in ${latest.claudeCodeVersion}:`, flag ? `first_seen ${flag.first_seen}, status ${flag.status}` : 'absent');

  // Removal = vanish: /vim was removed in 2.1.92, so it's present at .91, gone at .92.
  const at91 = findSymbol(await fetchSnapshot('2.1.91'), '/vim');
  const at92 = findSymbol(await fetchSnapshot('2.1.92'), '/vim');
  console.log(`/vim @2.1.91:`, at91 ? `present (removed_in=${at91.removed_in})` : 'absent', '| @2.1.92:', at92 ? 'present' : 'vanished');

  // Description-at-version: --add-dir's help text changed at 1.0.23.
  console.log('--add-dir @1.0.18:', await describeAt('cli_flag', '--add-dir', '1.0.18'));
  console.log('--add-dir @1.0.23:', await describeAt('cli_flag', '--add-dir', '1.0.23'));
}

// Run only when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
