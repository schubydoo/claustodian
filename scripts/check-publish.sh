#!/usr/bin/env bash
# Copyright 2026 Schuby
# SPDX-License-Identifier: Apache-2.0
#
# Check-only. Asserts the published site is actually serving what the repo expects.
# Makes no changes and triggers no deploy.
#
# Exists because two failures already shipped unnoticed:
#   1. Actions-built Pages does NOT rebuild on a custom-domain change, leaving the
#      domain on GitHub's 404 while the old github.io URL kept working.
#      `status: null` from the Pages API is the tell.
#   2. Fastly caches per edge, so a stale 200 from one region reads as success.
#      Cache headers are printed so a HIT is never mistaken for proof.
#
# Usage:  bash scripts/check-publish.sh
# The Pages API check needs `gh` authenticated; it is skipped otherwise.
set -uo pipefail

SITE="${SITE:-https://claustodian.dev}"
REPO="${REPO:-schubydoo/claustodian}"
status=0

# A check that silently skips when a tool is missing is worse than no check: it
# prints OK and proves nothing. Fail closed instead.
for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool is required and not on PATH. Refusing to report a result."
    exit 1
  fi
done

hr() { printf '%s\n' '--------------------------------------------------'; }

# Is the site actually serving? This, not the API's status field, is the real
# signal — see the Pages-configuration note below.
root_code="$(curl -sSL -o /dev/null -w '%{http_code}' "$SITE/" 2>/dev/null)"

hr
echo "Pages configuration"
hr
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  pages="$(gh api "repos/$REPO/pages" 2>/dev/null)"
  if [ -z "$pages" ]; then
    echo "SKIP: Pages API returned nothing (no admin access?)"
  else
    if ! build_status="$(printf '%s' "$pages" | jq -er '.status // "null"' 2>/dev/null)"; then
      echo "  FAIL: could not parse the Pages API response."
      status=1
      build_status=''
    fi
    cname="$(printf '%s' "$pages" | jq -r '.cname // "none"' 2>/dev/null)"
    verified="$(printf '%s' "$pages" | jq -r '.protected_domain_state // "none"' 2>/dev/null)"
    echo "  cname:            $cname"
    echo "  status:           $build_status"
    echo "  domain verified:  $verified"
    # `status` is null on healthy Actions-built Pages too, so it is NOT diagnostic
    # on its own. It is only meaningful alongside a site that is not serving: that
    # combination is the known custom-domain trap, where changing the domain does
    # not trigger a rebuild.
    if [ "$build_status" = "null" ] && [ "$root_code" != "200" ]; then
      echo "  FAIL: status is null AND $SITE/ returned $root_code."
      echo "        This is the custom-domain trap — a domain change does not"
      echo "        trigger a rebuild. Re-run the publish workflow:"
      echo "        gh run rerun <id> --repo $REPO"
      status=1
    elif [ "$build_status" = "null" ]; then
      echo "  note: a null status is normal for Actions-built Pages. It only"
      echo "        indicates the domain trap when the site is also not serving."
    fi
    if [ "$verified" != "verified" ]; then
      echo "  note: domain verification is not enabled — guards against takeover"
      echo "        if Pages is ever disabled."
    fi
  fi
else
  echo "SKIP: gh not available or not authenticated."
fi

hr
echo "Endpoints"
hr
check_url() {
  local path="$1" expect="${2:-200}"
  local code
  code="$(curl -sSL -o /dev/null -w '%{http_code}' "$SITE$path" 2>/dev/null)"
  if [ "$code" = "$expect" ]; then
    printf '  ok    %-34s %s\n' "$path" "$code"
  else
    printf '  FAIL  %-34s %s (expected %s)\n' "$path" "$code" "$expect"
    status=1
  fi
}
for p in / /llms.txt /favicon.svg /og-image.png /review/ \
  /data/index.json /data/latest.json /data/catalog.json /data/docs.json \
  /data/schema-version.json /data/binary-descriptions.json; do
  check_url "$p"
done
# Documented as JSON-only: the catalog is built after the export step.
check_url /data/catalog.yaml 404

hr
echo "Freshness — does the site serve the repo's newest version?"
hr
repo_latest="$(find data/versions -maxdepth 1 -name '*.json' -exec basename {} .json \; 2>/dev/null |
  sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
site_latest="$(curl -sSL "$SITE/data/index.json" 2>/dev/null | jq -r '.latest // empty' 2>/dev/null)"
echo "  repo: ${repo_latest:-unknown}"
echo "  site: ${site_latest:-unreachable}"
# Empty on either side means the comparison did not happen. Skipping it silently
# would let the script print OK while proving nothing about freshness.
if [ -z "$repo_latest" ]; then
  echo "  FAIL: no snapshots under data/versions — cannot determine the repo's newest version."
  status=1
elif [ -z "$site_latest" ]; then
  echo "  FAIL: could not read .latest from $SITE/data/index.json (unreachable or unparseable)."
  status=1
elif [ "$repo_latest" != "$site_latest" ]; then
  echo "  FAIL: mismatch — the deploy is behind, or did not run."
  status=1
fi

hr
echo "Cache headers — a HIT proves nothing about current state"
hr
curl -sSI "$SITE/data/index.json" 2>/dev/null |
  grep -iE '^(HTTP|x-cache|age|last-modified|cache-control)' | sed 's/^/  /'
echo
echo "  If x-cache is HIT with a nonzero age, this host is reading a warm edge."
echo "  Confirm from a second vantage point before believing a green result."

hr
[ "$status" -eq 0 ] && echo "OK: published site matches expectations." || echo "FAILURES above."
exit "$status"
