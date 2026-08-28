#!/usr/bin/env python3
"""Validate the lightweight OpenDelegate setup-kit tree.

This deliberately checks repository mechanics rather than prose wording:
local Markdown links, accidental private infrastructure, credential-like
assignments, and unresolved conflict markers.
"""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LINK_PATTERN = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
PRIVATE_IP = re.compile(
    r"\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|"
    r"172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b"
)
OWNER_PATH = re.compile(
    r"(?i)\bC:[/\\]Users[/\\](?!<|USER|USERNAME|your[-_ ]?user)"
    r"[A-Za-z0-9._-]+"
)
CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?i)(?:api[_-]?key|secret|password|token|private[_-]?key)"
    r"\s*[:=]\s*['\"]([^'\"]{6,})['\"]"
)
CONFLICT_MARKER = re.compile(r"^(?:<<<<<<<|=======|>>>>>>>)")


def tracked_files() -> list[str]:
    output = subprocess.check_output(
        ["git", "ls-files"],
        cwd=ROOT,
        text=True,
    )
    return [line for line in output.splitlines() if line]


def main() -> int:
    tracked = tracked_files()
    failures: list[str] = []

    for relative in tracked:
        path = ROOT / relative
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        if path.suffix.lower() in {".md", ".markdown"}:
            for target in LINK_PATTERN.findall(text):
                target = target.strip()
                local = target.split("#", 1)[0].strip()
                if not local or re.match(r"^(?:https?://|mailto:|#)", target):
                    continue
                local = local.replace("%20", " ")
                if not (path.parent / local).resolve().exists():
                    failures.append(f"broken link: {relative} -> {target}")

        for lineno, line in enumerate(text.splitlines(), 1):
            checks = (
                ("private IPv4 address", PRIVATE_IP),
                ("owner-specific Windows path", OWNER_PATH),
                ("credential-like assignment", CREDENTIAL_ASSIGNMENT),
                ("conflict marker", CONFLICT_MARKER),
            )
            for label, pattern in checks:
                if pattern.search(line):
                    failures.append(f"{label}: {relative}:{lineno}")

    print(f"tracked files checked: {len(tracked)}")
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    print("setup-kit verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
