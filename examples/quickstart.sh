#!/usr/bin/env bash
# Copyright 2026 Schuby
# SPDX-License-Identifier: Apache-2.0
#
# Claustodian in ~10 lines of curl + jq. No client library needed — the data is
# static JSON at stable URLs. Run:  bash examples/quickstart.sh
set -euo pipefail

BASE="${CLAUSTODIAN_BASE:-https://schubydoo.github.io/claustodian/data}"

echo "== tracked versions + latest =="
curl -fsSL "$BASE/index.json" | jq '{latest, tracked: (.versions | length)}'

echo "== what is --output-format in the latest release? =="
curl -fsSL "$BASE/latest.json" \
  | jq '.symbols[] | select(.symbol == "--output-format")
        | {first_seen, removed_in, status, description}'

echo "== is CLAUDE_CODE_SAFE_MODE present in 2.1.169? (exit 0 = yes) =="
if curl -fsSL "$BASE/versions/2.1.169.json" \
     | jq -e '.symbols[] | select(.symbol == "CLAUDE_CODE_SAFE_MODE")' >/dev/null; then
  echo "  available"
else
  echo "  not available"
fi

echo "== first 20 env vars available in 2.1.169 =="
# Slice inside jq (not `| head`): with `set -o pipefail`, head closing the pipe
# early would SIGPIPE jq and abort the script before the examples below.
curl -fsSL "$BASE/versions/2.1.169.json" \
  | jq -r '[.symbols[] | select(.type == "env_var") | .symbol] | sort | .[:20][]'

echo "== removal = vanish: /vim is present at 2.1.91, gone at 2.1.92 =="
curl -fsSL "$BASE/versions/2.1.91.json" | jq -r \
  '(.symbols[] | select(.symbol == "/vim") | "  2.1.91: present, removed_in=\(.removed_in)") // "  2.1.91: absent"'
curl -fsSL "$BASE/versions/2.1.92.json" | jq -r \
  'if any(.symbols[]; .symbol == "/vim") then "  2.1.92: present" else "  2.1.92: vanished" end'

echo "== how --add-dir's description changed over time =="
curl -fsSL "$BASE/binary-descriptions.json" \
  | jq '.descriptions["cli_flag:--add-dir"]'
