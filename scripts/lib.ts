// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for `scripts/*.ts`: the upstream changelog URL, the
 * changelog loader (local file or remote fetch), and the "run only when
 * invoked directly" guard used by each script's CLI entry point.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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
