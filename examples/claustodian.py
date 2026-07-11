#!/usr/bin/env python3
# Copyright 2026 Schuby
# SPDX-License-Identifier: Apache-2.0
"""Minimal stdlib-only client for the Claustodian dataset.

Claustodian answers: "does a Claude Code symbol (CLI flag / env var / slash
command) exist in version Y, and what did it do at that version?" The data is
static JSON on GitHub Pages -- this client fetches it and applies the three rules
that matter (availability, removal=vanish, describe-at-version).

No third-party deps. Run the demo:  python3 examples/claustodian.py
The pure helpers (compare_semver / available_at / resolve_era) take already-loaded
data, so you can unit-test them without the network.
"""
from __future__ import annotations

import json
from urllib.request import urlopen

DEFAULT_BASE = "https://schubydoo.github.io/claustodian/data"


def compare_semver(a: str, b: str) -> int:
    """Compare two 'X.Y.Z' versions -> -1, 0, or 1 (semver order, not string)."""
    pa = [int(x) for x in a.split(".")]
    pb = [int(x) for x in b.split(".")]
    for i in range(max(len(pa), len(pb))):
        d = (pa[i] if i < len(pa) else 0) - (pb[i] if i < len(pb) else 0)
        if d != 0:
            return -1 if d < 0 else 1
    return 0


def available_at(sym: dict, version: str) -> bool:
    """first_seen <= version AND (removed_in is null OR removed_in > version)."""
    if compare_semver(sym["first_seen"], version) > 0:
        return False
    removed = sym.get("removed_in")
    if removed and compare_semver(removed, version) <= 0:
        return False
    return True


def resolve_era(timeline: list[dict], version: str) -> str | None:
    """The description in effect at `version` from a change-point timeline."""
    current = None
    for era in timeline:  # oldest-first
        if compare_semver(era["from"], version) <= 0:
            current = era["description"]
        else:
            break
    return current


def _get_json(url: str):
    with urlopen(url) as resp:  # noqa: S310 - fixed https host
        return json.load(resp)


def fetch_index(base: str = DEFAULT_BASE) -> dict:
    """Tracked versions (newest-first) plus the latest tag."""
    return _get_json(f"{base}/index.json")


def fetch_snapshot(version: str, base: str = DEFAULT_BASE) -> dict:
    """Full symbol snapshot for a version, or the newest one when version == 'latest'."""
    path = "latest.json" if version == "latest" else f"versions/{version}.json"
    return _get_json(f"{base}/{path}")


def find_symbol(snapshot: dict, symbol: str) -> dict | None:
    """Look up a symbol by its exact token (e.g. '--output-format', '/init')."""
    return next((s for s in snapshot["symbols"] if s["symbol"] == symbol), None)


def describe_at(sym_type: str, symbol: str, version: str, base: str = DEFAULT_BASE) -> str | None:
    """Description-at-version from binary-descriptions.json (key = 'type:symbol')."""
    doc = _get_json(f"{base}/binary-descriptions.json")
    timeline = doc["descriptions"].get(f"{sym_type}:{symbol}")
    return resolve_era(timeline, version) if timeline else None


def _demo() -> None:
    idx = fetch_index()
    print(f"Claustodian schema {idx['schemaVersion']}, latest {idx['latest']}, "
          f"{len(idx['versions'])} versions tracked")

    latest = fetch_snapshot("latest")
    flag = find_symbol(latest, "--output-format")
    print(f"--output-format in {latest['claudeCodeVersion']}:",
          f"first_seen {flag['first_seen']}, status {flag['status']}" if flag else "absent")

    # Removal = vanish: /vim removed in 2.1.92 -> present at .91, gone at .92.
    at91 = find_symbol(fetch_snapshot("2.1.91"), "/vim")
    at92 = find_symbol(fetch_snapshot("2.1.92"), "/vim")
    print(f"/vim @2.1.91:", f"present (removed_in={at91['removed_in']})" if at91 else "absent",
          "| @2.1.92:", "present" if at92 else "vanished")

    # Description-at-version: --add-dir's help text changed at 1.0.23.
    print("--add-dir @1.0.18:", describe_at("cli_flag", "--add-dir", "1.0.18"))
    print("--add-dir @1.0.23:", describe_at("cli_flag", "--add-dir", "1.0.23"))


if __name__ == "__main__":
    _demo()
