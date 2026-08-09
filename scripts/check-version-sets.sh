#!/usr/bin/env bash
# Copyright 2026 Schuby
# SPDX-License-Identifier: Apache-2.0
#
# Check-only. Reconciles the three version sets before a re-extract:
#
#   scratch/binaries/    the local archive        (maintainer-only, gitignored)
#   binary-cache/*.json  committed extractions
#   CHANGELOG            announced releases
#
# `reextract-binaries` reads ONLY the archive and clears binary-cache first, so a
# version that exists in the cache but not the archive is destroyed by a run that
# still reports success. That is what this script exists to catch.
#
# Exits non-zero when a set is missing something a maintainer must act on. Eight
# versions genuinely 404 upstream and are reported separately, never as failures.
#
# Usage:  bash scripts/check-version-sets.sh
set -euo pipefail

ARCHIVE_DIR="${ARCHIVE_DIR:-scratch/binaries}"
CACHE_DIR="${CACHE_DIR:-binary-cache}"
DATA_DIR="${DATA_DIR:-data}"

# Genuinely absent from the CDN — re-confirm before adding to this list.
PERMANENT_GAPS=(0.2.21 0.2.26 0.2.63 0.2.75 0.2.82 1.0.97 2.1.43 2.1.46)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# `comm` needs lexicographic input. `sort -V` looks right and silently mis-diffs.
list_cache() {
  find "$CACHE_DIR" -maxdepth 1 -name '[0-9]*.json' -exec basename {} .json \; 2>/dev/null | sort
}
list_archive() {
  [ -d "$ARCHIVE_DIR" ] || return 0
  find "$ARCHIVE_DIR" -maxdepth 1 -mindepth 1 -exec basename {} \; 2>/dev/null |
    sed 's/\.[a-z.]*$//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
}
list_snapshots() {
  find "$DATA_DIR/versions" -maxdepth 1 -name '*.json' -exec basename {} .json \; 2>/dev/null | sort
}

list_cache > "$tmp/cache"
list_archive > "$tmp/archive"
list_snapshots > "$tmp/snapshots"
printf '%s\n' "${PERMANENT_GAPS[@]}" | sort > "$tmp/gaps"

# Print at most 10 entries, then a count. Never truncate silently.
show_capped() {
  local file="$1" n
  n="$(wc -l < "$file" | tr -d ' ')"
  head -10 "$file" | sed 's/^/  /'
  [ "$n" -gt 10 ] && echo "  … and $((n - 10)) more ($n total)"
  return 0
}

status=0
printf 'archive   %s\ncache     %s\nsnapshots %s\n\n' \
  "$(wc -l < "$tmp/archive" | tr -d ' ')" \
  "$(wc -l < "$tmp/cache" | tr -d ' ')" \
  "$(wc -l < "$tmp/snapshots" | tr -d ' ')"

if [ ! -s "$tmp/archive" ]; then
  echo "NOTE: no local archive at $ARCHIVE_DIR — skipping archive comparisons."
  echo "      Do NOT run 'npm run reextract-binaries' without it; it would clear the cache."
  echo
else
  # The dangerous direction: in the cache, absent from the archive.
  if comm -23 "$tmp/cache" "$tmp/archive" > "$tmp/cache_only" && [ -s "$tmp/cache_only" ]; then
    echo "FAIL: in binary-cache but NOT in the archive — a re-extract would DELETE these:"
    sed 's/^/  /' "$tmp/cache_only"
    echo "      Fetch each with: npm run scrape-binary -- --version <v> --force"
    echo
    status=1
  fi
  if comm -13 "$tmp/cache" "$tmp/archive" > "$tmp/archive_only" && [ -s "$tmp/archive_only" ]; then
    echo "INFO: archived but not yet extracted (a re-extract will pick these up):"
    show_capped "$tmp/archive_only"
    echo
  fi
fi

# Snapshots without a cache entry are fine (changelog/docs-only symbols exist);
# the reverse is what matters, so only report the actionable direction.
if comm -23 "$tmp/snapshots" "$tmp/cache" > "$tmp/no_cache" && [ -s "$tmp/no_cache" ]; then
  uncovered="$(comm -23 "$tmp/no_cache" "$tmp/gaps" || true)"
  if [ -n "$uncovered" ]; then
    echo "INFO: snapshots with no binary extraction (not necessarily a problem):"
    printf '%s\n' "$uncovered" > "$tmp/uncovered"
    show_capped "$tmp/uncovered"
    echo
  fi
fi

echo "Known-permanent CDN gaps (expected, not failures):"
printf '%s\n' "${PERMANENT_GAPS[@]}" | sed 's/^/  /'

[ "$status" -eq 0 ] && echo && echo "OK: no version-set mismatch that would lose data."
exit "$status"
