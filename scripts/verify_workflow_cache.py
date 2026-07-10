#!/usr/bin/env python3
"""Fail fast if the rolling AMeDAS cache regresses to an immutable daily key."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "update-water-care-pages.yml"
ACTION_SHA = "caa296126883cff596d87d8935842f9db880ef25"
CACHE_PATH = "generator/outputs/uruoi/input_cache/raw"


def step_block(workflow: str, name: str) -> tuple[int, str]:
    marker = f"      - name: {name}\n"
    start = workflow.find(marker)
    if start < 0:
        raise AssertionError(f"missing workflow step: {name}")
    end = workflow.find("\n      - name:", start + len(marker))
    if end < 0:
        end = len(workflow)
    return start, workflow[start:end]


def require(block: str, value: str, errors: list[str], label: str) -> None:
    if value not in block:
        errors.append(f"{label} is missing: {value}")


def main() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    errors: list[str] = []

    try:
        restore_at, restore = step_block(workflow, "Restore rolling AMeDAS cache")
        generate_at, _ = step_block(workflow, "Generate and verify schema 4 data")
        save_at, save = step_block(workflow, "Save updated rolling AMeDAS cache")
    except AssertionError as exc:
        raise SystemExit(f"workflow cache contract failed:\n{exc}") from exc

    require(
        workflow,
        "concurrency:\n  group: water-care-pages-production\n  cancel-in-progress: false",
        errors,
        "serialized production concurrency",
    )
    require(restore, "id: amedas-cache", errors, "AMeDAS restore step id")
    require(
        restore,
        f"uses: actions/cache/restore@{ACTION_SHA}",
        errors,
        "standalone cache restore action",
    )
    require(restore, f"path: {CACHE_PATH}", errors, "AMeDAS restore path")
    require(
        restore,
        "key: water-care-amedas-v2-${{ runner.os }}-${{ steps.cache-date.outputs.date }}-"
        "${{ steps.sources.outputs.amedas }}-${{ github.run_id }}-${{ github.run_attempt }}",
        errors,
        "per-run AMeDAS cache key",
    )

    restore_keys = """restore-keys: |
            water-care-amedas-v2-${{ runner.os }}-${{ steps.cache-date.outputs.date }}-
            water-care-amedas-v2-${{ runner.os }}-
            water-care-amedas-v1-${{ runner.os }}-${{ steps.cache-date.outputs.date }}
            water-care-amedas-v1-${{ runner.os }}-"""
    require(
        restore,
        restore_keys,
        errors,
        "ordered same-day, rolling, and v1 migration restore keys",
    )

    require(
        save,
        f"uses: actions/cache/save@{ACTION_SHA}",
        errors,
        "standalone cache save action",
    )
    require(save, f"path: {CACHE_PATH}", errors, "AMeDAS save path")
    require(
        save,
        "key: ${{ steps.amedas-cache.outputs.cache-primary-key }}",
        errors,
        "AMeDAS save primary key",
    )
    if not restore_at < generate_at < save_at:
        errors.append("AMeDAS cache must restore before generation and save only after generation succeeds")

    for label, block in (("restore", restore), ("save", save)):
        if "secrets." in block or "vars." in block:
            errors.append(f"AMeDAS {label} step must not expose secrets or repository variables in cache metadata")

    frozen_daily_key = (
        "key: water-care-amedas-v1-${{ runner.os }}-${{ steps.cache-date.outputs.date }}\n"
    )
    if frozen_daily_key in workflow:
        errors.append("immutable daily AMeDAS primary key must not be restored")

    if errors:
        raise SystemExit("workflow cache contract failed:\n- " + "\n- ".join(errors))
    print("workflow cache contract passed: serialized per-run save with same-day rolling restore")


if __name__ == "__main__":
    main()
