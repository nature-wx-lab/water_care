#!/usr/bin/env python3
"""Independently verify the exact public GitHub Pages payload."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath


ROOT_FILES = {
    "index.html",
    "app.js",
    "styles.css",
    "ui-v12.css",
    "map-data.css",
    "detail.css",
    "labels.css",
    "mydata.css",
    "deployment.json",
}
STATIC_DATA_FILES = {
    "data/current_moisture.csv.gz",
    "data/moisture_manifest.json",
    "data/presets.json",
    "data/static/grid_land_class.bin",
    "data/static/grid_land_class_manifest.json",
    "data/static/grid_master.csv.gz",
    "data/static/grid_points.bin",
    "data/static/grid_pref_names.json",
    "data/static/place_labels.json",
    "data/static/prefectures.geojson",
}
VENDOR_FILES = {
    "vendor/leaflet-1.9.4/LICENSE",
    "vendor/leaflet-1.9.4/leaflet.css",
    "vendor/leaflet-1.9.4/leaflet.js",
    "vendor/leaflet-1.9.4/images/marker-icon-2x.png",
    "vendor/leaflet-1.9.4/images/marker-icon.png",
    "vendor/leaflet-1.9.4/images/marker-shadow.png",
}
CORE_FILES = {
    "index.html",
    "app.js",
    "styles.css",
    "ui-v12.css",
    "data/moisture_manifest.json",
    "data/presets.json",
    "data/static/grid_land_class.bin",
    "data/static/grid_land_class_manifest.json",
}
TEXT_SUFFIXES = {
    ".html", ".css", ".js", ".json", ".geojson", ".csv", ".md", ".txt", ".xml",
}
GZIP_TEXT_FILES = {
    "data/current_moisture.csv.gz",
    "data/static/grid_master.csv.gz",
}
FORBIDDEN_PARTS = {
    ".git", ".github", "scripts", "state", "fixtures", "screenshots", "logs",
    "__pycache__", ".venv", "node_modules", ".cache", "outputs", "input_cache",
}
ALLOWED_EMAILS = {
    "nature-wx-lab@users.noreply.github.com",
    "289840956+nature-wx-lab@users.noreply.github.com",
    "41898282+github-actions[bot]@users.noreply.github.com",
}
PATTERNS = (
    re.compile(r"/Users/|[A-Za-z]:\\\\|private/var"),
    re.compile(r"github_pat_|ghp_[A-Za-z0-9]+"),
    re.compile(r"(?i)(token|secret|password|api[ _-]?key)\s*[:=]\s*[\"'][^\"']+[\"']"),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
)
COMMIT_RE = re.compile(r"^[0-9a-f]{7,64}$")
EXPECTED_LAND_MASK_SHA256 = "2ccff1d901cf2cf8b90983aa3959f7636a64d55067167f322c2ebffc873f4394"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_data_reference(value: object) -> str:
    reference = str(value or "")
    path = PurePosixPath(reference)
    if not reference or path.is_absolute() or ".." in path.parts or any(part.startswith(".") for part in path.parts):
        raise RuntimeError(f"unsafe data reference: {reference!r}")
    return f"data/{path.as_posix()}"


def expected_files(manifest: dict[str, object]) -> set[str]:
    expected = set(ROOT_FILES) | set(STATIC_DATA_FILES) | set(VENDOR_FILES)
    hourly = manifest.get("hourly") or {}
    for references in (hourly.get("files") or {}).values():
        for key in ("moisture", "labels", "rootrot_labels", "water_balance"):
            expected.add(safe_data_reference((references or {}).get(key)))
    for key in ("rain", "temperature"):
        expected.add(safe_data_reference(hourly.get(key)))
    hourly_medaka = hourly.get("medaka") or {}
    for key in ("level_cm", "risk"):
        expected.add(safe_data_reference(hourly_medaka.get(key)))
    for slot in manifest.get("slots") or []:
        for references in (slot.get("layers") or {}).values():
            for key in ("file", "label_file", "rootrot_label_file"):
                expected.add(safe_data_reference((references or {}).get(key)))
    for slot in (manifest.get("medaka") or {}).get("slots") or []:
        for key in ("level_file", "risk_file"):
            expected.add(safe_data_reference(slot.get(key)))
    expected.add(safe_data_reference(manifest.get("daily")))
    return expected


def scan_text_content(text: str, label: str, denylist: list[str]) -> list[str]:
    findings: list[str] = []
    for number, line in enumerate(text.splitlines(), 1):
        for pattern in PATTERNS:
            match = pattern.search(line)
            if match and not ("@" in match.group(0) and match.group(0) in ALLOWED_EMAILS):
                findings.append(f"{label}:{number}: privacy pattern")
        if any(value in line for value in denylist):
            findings.append(f"{label}:{number}: denylist")
    return findings


def scan_text(path: Path, label: str, denylist: list[str]) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as error:
        return [f"{label}: unreadable public text: {error}"]
    return scan_text_content(text, label, denylist)


def verify(
    pages: Path,
    *,
    source_commit: str,
    generator_commit: str,
    max_bytes: int,
    denylist: list[str],
) -> dict[str, object]:
    if not COMMIT_RE.fullmatch(source_commit) or not COMMIT_RE.fullmatch(generator_commit):
        raise RuntimeError("source and generator commits must be lowercase hexadecimal ids")
    pages = pages.resolve()
    if not pages.is_dir():
        raise RuntimeError(f"Pages directory is missing: {pages}")

    for path in [pages, *pages.rglob("*")]:
        relative = path.relative_to(pages)
        if path.is_symlink():
            raise RuntimeError(f"Pages payload contains a symlink: {relative}")
        if relative.parts and (any(part.startswith(".") for part in relative.parts) or any(part in FORBIDDEN_PARTS for part in relative.parts)):
            raise RuntimeError(f"Pages payload contains a forbidden path: {relative}")

    manifest_path = pages / "data/moisture_manifest.json"
    deployment_path = pages / "deployment.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    deployment = json.loads(deployment_path.read_text(encoding="utf-8"))
    expected = expected_files(manifest)
    actual = {path.relative_to(pages).as_posix() for path in pages.rglob("*") if path.is_file()}
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise RuntimeError(f"Pages file allowlist mismatch; missing={missing}, unexpected={unexpected}")

    payload_files = sorted(path for path in pages.rglob("*") if path.is_file() and path != deployment_path)
    payload_bytes = sum(path.stat().st_size for path in payload_files)
    if payload_bytes > max_bytes:
        raise RuntimeError(f"Pages payload exceeds size gate: {payload_bytes} > {max_bytes}")
    if deployment.get("payload_file_count") != len(payload_files) or deployment.get("payload_bytes") != payload_bytes:
        raise RuntimeError("deployment payload count/size mismatch")
    if deployment.get("source_commit") != source_commit or deployment.get("generator_commit") != generator_commit:
        raise RuntimeError("deployment commit identity mismatch")
    if deployment.get("dataset_id") != manifest.get("dataset_id"):
        raise RuntimeError("deployment dataset identity mismatch")
    if manifest.get("schema_version") != 4 or manifest.get("generator_version") != 5 or manifest.get("grid_count") != 31296:
        raise RuntimeError("public data schema/generator/grid contract mismatch")
    hourly = manifest.get("hourly") or {}
    hours = len(hourly.get("times") or [])
    reforecast = hourly.get("reforecast") or {}
    expected_reforecast = {
        "schema_version": 1,
        "dtype": "float32",
        "byte_order": "little_endian",
        "layout": "row_major_hours_grid",
        "bytes_per_value": 4,
        "unit": "percentage_points_per_hour",
        "shape": [hours, 31296],
        "delta_index_semantics": "delta_at_index_h_advances_state_from_h_minus_1_to_h",
        "event_application": "after_transition_at_event_index",
        "water_full_target_pct": 95,
        "water_light_increment_pct": 40,
        "scope": "standard_mode_water_balance_only",
    }
    if any(reforecast.get(key) != value for key, value in expected_reforecast.items()):
        raise RuntimeError("public MyData reforecast contract mismatch")
    if not str(reforecast.get("first_index_note") or "").strip() or not str(reforecast.get("privacy_note") or "").strip():
        raise RuntimeError("public MyData reforecast notes are missing")

    core_hashes = deployment.get("core_sha256") or {}
    if set(core_hashes) != CORE_FILES:
        raise RuntimeError("deployment core hash allowlist mismatch")
    for name in CORE_FILES:
        if core_hashes.get(name) != sha256(pages / name):
            raise RuntimeError(f"deployment core hash mismatch: {name}")
    if sha256(pages / "data/static/grid_land_class.bin") != EXPECTED_LAND_MASK_SHA256:
        raise RuntimeError("fixed Japan land mask sha256 mismatch")

    findings: list[str] = []
    for name in sorted(actual):
        path = pages / name
        if path.suffix.lower() in TEXT_SUFFIXES or path.name == "LICENSE":
            findings.extend(scan_text(path, name, denylist))
    for name in sorted(GZIP_TEXT_FILES):
        try:
            with gzip.open(pages / name, "rb") as handle:
                raw = handle.read(50 * 1024 * 1024 + 1)
            if len(raw) > 50 * 1024 * 1024:
                raise RuntimeError(f"expanded gzip text exceeds 50 MiB: {name}")
            text = raw.decode("utf-8-sig")
        except (OSError, UnicodeDecodeError) as error:
            raise RuntimeError(f"unable to inspect gzip text {name}: {error}") from error
        if len(text.splitlines()) != 31_297:
            raise RuntimeError(f"gzip CSV row count mismatch: {name}")
        findings.extend(scan_text_content(text, name, denylist))
    if findings:
        raise RuntimeError("Pages privacy scan failed:\n" + "\n".join(findings))

    return {
        "files": len(actual),
        "payload_bytes": payload_bytes,
        "dataset_id": manifest.get("dataset_id"),
        "source_commit": source_commit,
        "generator_commit": generator_commit,
        "land_mask_sha256": EXPECTED_LAND_MASK_SHA256,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages-dir", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--generator-commit", required=True)
    parser.add_argument("--max-mib", type=int, default=700)
    args = parser.parse_args()
    denylist = [value for value in os.environ.get("PRIVACY_DENYLIST", "").splitlines() if value.strip()]
    try:
        result = verify(
            args.pages_dir,
            source_commit=args.source_commit,
            generator_commit=args.generator_commit,
            max_bytes=args.max_mib * 1024 * 1024,
            denylist=denylist,
        )
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, RuntimeError) as error:
        raise SystemExit(f"Pages payload verification failed: {error}") from error
    print("Pages payload verification passed: " + json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
