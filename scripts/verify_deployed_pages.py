#!/usr/bin/env python3
"""Poll a deployed water_care Pages artifact and verify release identity."""
from __future__ import annotations

import argparse
import hashlib
import json
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

import certifi


def fetch_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": "NatureWxLab-WaterCare-DeployVerifier/1.0", "Cache-Control": "no-cache"})
    with urlopen(request, timeout=30, context=ssl.create_default_context(cafile=certifi.where())) as response:
        return response.read()


def verify_once(
    base_url: str,
    *,
    source_commit: str,
    generator_commit: str,
    dataset_id: str,
) -> dict[str, object]:
    nonce = str(time.time_ns())
    deployment_url = urljoin(base_url.rstrip("/") + "/", f"deployment.json?verify={nonce}")
    deployment = json.loads(fetch_bytes(deployment_url).decode("utf-8"))
    expected = {
        "source_commit": source_commit,
        "generator_commit": generator_commit,
        "dataset_id": dataset_id,
        "data_schema_version": 4,
        "generator_version": 5,
        "grid_count": 31296,
    }
    mismatches = {key: (deployment.get(key), value) for key, value in expected.items() if deployment.get(key) != value}
    if mismatches:
        raise RuntimeError(f"deployment identity mismatch: {mismatches}")
    for relative, expected_hash in (deployment.get("core_sha256") or {}).items():
        payload = fetch_bytes(urljoin(base_url.rstrip("/") + "/", f"{relative}?verify={nonce}"))
        actual_hash = hashlib.sha256(payload).hexdigest()
        if actual_hash != expected_hash:
            raise RuntimeError(f"deployed hash mismatch: {relative}")
    manifest = json.loads(fetch_bytes(urljoin(base_url.rstrip("/") + "/", f"data/moisture_manifest.json?verify={nonce}")).decode("utf-8"))
    if (
        manifest.get("dataset_id") != dataset_id
        or manifest.get("schema_version") != 4
        or manifest.get("generator_version") != 5
        or manifest.get("distribution_stats_basis") != "pre_quantized_float"
        or manifest.get("distribution_stats_scope", {}).get("included_classes") != [1, 2]
        or manifest.get("distribution_stats_scope", {}).get("grid_count") != 12404
    ):
        raise RuntimeError("deployed data manifest mismatch")
    hourly = manifest.get("hourly") or {}
    reforecast = hourly.get("reforecast") or {}
    expected_reforecast = {
        "schema_version": 1,
        "dtype": "float32",
        "byte_order": "little_endian",
        "layout": "row_major_hours_grid",
        "bytes_per_value": 4,
        "unit": "percentage_points_per_hour",
        "shape": [len(hourly.get("times") or []), 31296],
        "delta_index_semantics": "delta_at_index_h_advances_state_from_h_minus_1_to_h",
        "event_application": "after_transition_at_event_index",
        "water_full_target_pct": 95,
        "water_light_increment_pct": 40,
        "scope": "standard_mode_water_balance_only",
    }
    if any(reforecast.get(key) != value for key, value in expected_reforecast.items()):
        raise RuntimeError("deployed MyData reforecast contract mismatch")
    if not str(reforecast.get("first_index_note") or "").strip() or not str(reforecast.get("privacy_note") or "").strip():
        raise RuntimeError("deployed MyData reforecast notes are missing")
    required_land_core = {
        "data/static/grid_land_class.bin",
        "data/static/grid_land_class_manifest.json",
    }
    if not required_land_core.issubset(deployment.get("core_sha256") or {}):
        raise RuntimeError("deployed land mask core hashes are missing")
    land = deployment.get("land_mask") or {}
    if (
        land.get("schema_version") != 1
        or land.get("grid_count") != 31296
        or land.get("counts") != {"0": 18887, "1": 12254, "2": 150, "3": 5}
        or land.get("public_land_classes") != [1, 2]
    ):
        raise RuntimeError("deployed land mask metadata mismatch")
    return deployment


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--generator-commit", required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--attempts", type=int, default=20)
    parser.add_argument("--delay-seconds", type=float, default=15)
    args = parser.parse_args()
    last_error: Exception | None = None
    for attempt in range(1, args.attempts + 1):
        try:
            deployment = verify_once(
                args.base_url,
                source_commit=args.source_commit,
                generator_commit=args.generator_commit,
                dataset_id=args.dataset_id,
            )
            print(json.dumps(deployment, ensure_ascii=False, separators=(",", ":")))
            return
        except (HTTPError, URLError, TimeoutError, ConnectionError, json.JSONDecodeError, RuntimeError) as error:
            last_error = error
            if attempt == args.attempts:
                break
            print(f"deployed Pages not ready {attempt}/{args.attempts}: {type(error).__name__}", flush=True)
            time.sleep(args.delay_seconds)
    raise SystemExit(f"deployed Pages verification failed: {type(last_error).__name__ if last_error else 'unknown'}")


if __name__ == "__main__":
    main()
