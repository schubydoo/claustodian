// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for `scripts/*.ts`: the upstream changelog URL, the
 * changelog loader (local file or remote fetch), and the "run only when
 * invoked directly" guard used by each script's CLI entry point.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** The three symbol kinds every lane extracts (changelog, docs, binary). Lives
 * here — a dependency-free leaf — so lane modules share it without importing one
 * another. Narrower than a full SymbolRecord's `type` (no config keys). */
export type ExtractedSymbolType = 'cli_flag' | 'command' | 'env_var';

export const CHANGELOG_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';

/** Reads the changelog from `changelogPath` if given, else fetches `CHANGELOG_URL`. */
export async function loadChangelog(changelogPath: string | undefined): Promise<string> {
  if (changelogPath) {
    return readFile(changelogPath, 'utf-8');
  }

  const response = await fetch(CHANGELOG_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch changelog from ${CHANGELOG_URL}: ${response.status} ${response.statusText}`
    );
  }
  return response.text();
}

/** True when the file at `importMetaUrl` is the one Node was invoked with directly. */
export function isMain(importMetaUrl: string): boolean {
  return importMetaUrl === pathToFileURL(process.argv[1] ?? '').href;
}

function parseVersionParts(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number(part));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Numeric semver comparison (2.1.9 < 2.1.10), ascending. */
export function compareVersionsAsc(a: string, b: string): number {
  const [a1, a2, a3] = parseVersionParts(a);
  const [b1, b2, b3] = parseVersionParts(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}
