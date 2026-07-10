#!/usr/bin/env python3
"""Build the public station-name label asset from the canonical station inventory."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from collections import Counter
from pathlib import Path


MAJOR_PLACE_NAMES = {
    "稚内", "旭川", "札幌", "釧路", "青森", "盛岡", "秋田", "仙台", "山形", "福島",
    "新潟", "富山", "金沢", "福井", "宇都宮", "前橋", "水戸", "熊谷", "東京", "千葉",
    "横浜", "甲府", "長野", "岐阜", "静岡", "名古屋", "津", "彦根", "京都", "大阪",
    "神戸", "奈良", "和歌山", "鳥取", "松江", "岡山", "広島", "山口", "徳島", "高松",
    "松山", "高知", "福岡", "佐賀", "長崎", "熊本", "大分", "宮崎", "鹿児島", "那覇",
    "名瀬", "石垣島", "父島",
}
MIN_ZOOM_BY_RANK = {0: 0.9, 1: 1.9, 2: 3.8}
REGIONAL_LABELS = (
    ("regional:china", "中国", 116.4, 39.9),
    ("regional:south-korea", "韓国", 127.8, 36.5),
    ("regional:north-korea", "北朝鮮", 127.1, 40.2),
    ("regional:russia", "ロシア", 142.1, 46.2),
    ("regional:taiwan", "台湾", 121.0, 23.8),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def build(source: Path) -> dict[str, object]:
    source_bytes = source.read_bytes()
    with source.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    labels: list[dict[str, object]] = []
    for row in rows:
        if row.get("is_current") != "True" or row.get("has_temperature") != "True":
            continue
        try:
            latitude = float(row.get("latitude", ""))
            longitude = float(row.get("longitude", ""))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(latitude) or not math.isfinite(longitude):
            continue
        name = row.get("jma_name") or row.get("name")
        if not name:
            continue
        rank = 0 if name in MAJOR_PLACE_NAMES else 1 if row.get("kind") == "s" else 2
        labels.append(
            {
                "station_key": row.get("station_key", ""),
                "name": name,
                "longitude": longitude,
                "latitude": latitude,
                "station_kind": row.get("kind", ""),
                "rank": rank,
                "min_zoom": MIN_ZOOM_BY_RANK[rank],
            }
        )

    station_label_count = len(labels)
    labels.extend(
        {
            "station_key": key,
            "name": name,
            "longitude": longitude,
            "latitude": latitude,
            "station_kind": "regional",
            "rank": 0,
            "min_zoom": MIN_ZOOM_BY_RANK[0],
        }
        for key, name, longitude, latitude in REGIONAL_LABELS
    )
    rank_counts = Counter(label["rank"] for label in labels)
    return {
        "schema_version": 1,
        "source": {
            "id": "station_inventory_current_temperature",
            "logical_path": "data/weather/japan_all_stations/station_inventory_current_temperature.csv",
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
            "row_count": len(rows),
            "selection": "is_current=True and has_temperature=True with finite latitude/longitude and a station name",
        },
        "render_contract": {
            "ranking": "regional and major place name=0, station_kind s=1, other current temperature station=2",
            "regional_labels": [name for _, name, _, _ in REGIONAL_LABELS],
            "sort": "rank ascending, then Japanese station name",
            "initial_leaflet_zoom": 5,
            "zoom_ratio": "2 ** (leaflet_zoom - initial_leaflet_zoom)",
            "min_zoom_ratio_by_rank": {str(rank): value for rank, value in MIN_ZOOM_BY_RANK.items()},
            "max_labels": [
                {"zoom_ratio_below": 1.6, "count": 38},
                {"zoom_ratio_below": 2.8, "count": 82},
                {"zoom_ratio_below": None, "count": 220},
            ],
            "collision": "axis-aligned text rectangles; first ranked label wins",
        },
        "label_count": len(labels),
        "station_label_count": station_label_count,
        "regional_label_count": len(REGIONAL_LABELS),
        "rank_counts": {str(rank): rank_counts[rank] for rank in MIN_ZOOM_BY_RANK},
        "labels": labels,
    }


def main() -> None:
    args = parse_args()
    payload = build(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {args.output}: {payload['label_count']} labels "
        f"from {payload['source']['row_count']} rows"
    )


if __name__ == "__main__":
    main()
