#!/usr/bin/env python3
"""Privacy gate for current files, reachable history, identities and messages."""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ALLOWED_IDENTITIES = {
    ("nature-wx-lab", "nature-wx-lab@users.noreply.github.com"),
    ("github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com"),
}
ALLOWED_EMAILS = {email for _, email in ALLOWED_IDENTITIES}
TEXT_SUFFIXES = {".html", ".css", ".js", ".mjs", ".py", ".json", ".geojson", ".csv", ".md", ".txt", ".yml", ".yaml", ".xml"}
FORBIDDEN_FILES = {".env", ".DS_Store"}
FORBIDDEN_PARTS = {"state", "fixtures", "screenshots", "logs", "__pycache__", ".venv", "node_modules", ".cache"}
PATTERNS = [
    re.compile(r"/Users/|[A-Za-z]:\\\\|private/var"),
    re.compile(r"github_pat_|ghp_[A-Za-z0-9]+"),
    re.compile(r"(?i)(token|secret|password|api[ _-]?key)\s*[:=]\s*[\"'][^\"']+[\"']"),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
]


def git(*args: str, text: bool = True):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=text)


def fail(items):
    for path, line, kind in items:
        print(f"privacy gate: {path}:{line} [{kind}]", file=sys.stderr)
    raise SystemExit(1)


def scan_text(label: object, text: str, deny: list[str], *, source_path: Path | None = None):
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        if source_path == Path("scripts/privacy_gate.py") and "re.compile(" in line:
            continue
        for pattern in PATTERNS:
            match = pattern.search(line)
            if not match:
                continue
            if "@" in match.group(0) and match.group(0) in ALLOWED_EMAILS:
                continue
            findings.append((label, number, "pattern"))
        if any(value in line for value in deny):
            findings.append((label, number, "denylist"))
    return findings


def forbidden_path(path: Path) -> bool:
    return path.name in FORBIDDEN_FILES or any(part in FORBIDDEN_PARTS for part in path.parts)


def scan_files(deny: list[str]):
    findings = []
    for path in ROOT.rglob("*"):
        rel = path.relative_to(ROOT)
        if ".git" in rel.parts or path.is_dir():
            continue
        if forbidden_path(rel):
            findings.append((rel, 0, "forbidden-file"))
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(errors="strict")
        except (UnicodeDecodeError, OSError):
            continue
        findings.extend(scan_text(rel, text, deny, source_path=rel))
    return findings


def scan_commits(deny: list[str]):
    if not (ROOT / ".git").exists():
        return []
    payload = git("log", "--all", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e")
    findings = []
    for record in payload.split("\x1e"):
        record = record.strip()
        if not record:
            continue
        parts = record.split("\x1f", 5)
        if len(parts) != 6:
            findings.append(("git-log", 0, "unparseable-commit"))
            continue
        commit, author_name, author_email, committer_name, committer_email, message = parts
        if (author_name, author_email) not in ALLOWED_IDENTITIES or (committer_name, committer_email) not in ALLOWED_IDENTITIES:
            findings.append((commit[:12], 0, "git-identity"))
        if scan_text(commit[:12], message, deny):
            findings.append((commit[:12], 0, "commit-message"))
    return findings


def scan_reachable_blobs(deny: list[str]):
    if not (ROOT / ".git").exists():
        return []
    findings = []
    seen: set[str] = set()
    for row in git("rev-list", "--objects", "--all").splitlines():
        if " " not in row:
            continue
        object_id, name = row.split(" ", 1)
        path = Path(name)
        if object_id in seen:
            continue
        seen.add(object_id)
        if forbidden_path(path):
            findings.append((name, 0, "historical-forbidden-file"))
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if git("cat-file", "-t", object_id).strip() != "blob":
            continue
        size = int(git("cat-file", "-s", object_id).strip())
        if size > 20 * 1024 * 1024:
            findings.append((name, 0, "historical-text-too-large-to-scan"))
            continue
        raw = git("cat-file", "blob", object_id, text=False)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(scan_text(f"{object_id[:12]}:{name}", text, deny, source_path=path))
    return findings


denylist = [value for value in os.environ.get("PRIVACY_DENYLIST", "").splitlines() if value.strip()]
findings = scan_files(denylist) + scan_commits(denylist) + scan_reachable_blobs(denylist)
if findings:
    fail(sorted(set(findings), key=lambda item: (str(item[0]), item[1], item[2])))
print("privacy gate passed: current files, reachable text history, commit messages and identities")
