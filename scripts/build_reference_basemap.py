#!/usr/bin/env python3
"""Build the lightweight East Asia basemap used by the public map UI.

The full Natural Earth source stays outside the Pages payload.  This command
clips it to the app's permitted map extent, simplifies display-only geometry,
and records enough source metadata to reproduce and audit the derivative.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from shapely.geometry import box, mapping, shape


DEFAULT_BOUNDS = (104.0, 18.0, 166.0, 54.0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tolerance", type=float, default=0.03)
    return parser.parse_args()


def round_coordinates(value: object, digits: int = 4) -> object:
    if isinstance(value, (list, tuple)):
        return [round_coordinates(item, digits) for item in value]
    if isinstance(value, float):
        return round(value, digits)
    return value


def main() -> None:
    args = parse_args()
    source_bytes = args.source.read_bytes()
    payload = json.loads(source_bytes)
    clip = box(*DEFAULT_BOUNDS)
    features: list[dict[str, object]] = []

    for source_index, feature in enumerate(payload.get("features", [])):
        geometry = shape(feature.get("geometry"))
        if geometry.is_empty or not geometry.intersects(clip):
            continue
        clipped = geometry.intersection(clip).simplify(args.tolerance, preserve_topology=True)
        if clipped.is_empty:
            continue
        geometry_payload = mapping(clipped)
        geometry_payload["coordinates"] = round_coordinates(geometry_payload["coordinates"])
        features.append({
            "type": "Feature",
            "properties": {"source_index": source_index},
            "geometry": geometry_payload,
        })

    result = {
        "type": "FeatureCollection",
        "name": "water_care_reference_basemap_east_asia",
        "metadata": {
            "schema_version": 1,
            "source_dataset": "Natural Earth ne_10m_admin_0_countries",
            "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
            "license": "Public Domain",
            "derivative": "clipped and simplified for display only",
            "bounds": list(DEFAULT_BOUNDS),
            "simplify_tolerance_degrees": args.tolerance,
            "feature_count": len(features),
        },
        "features": features,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result["metadata"], ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
