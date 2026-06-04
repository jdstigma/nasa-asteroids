"""
flatten_asteroids.py
--------------------
Converts the raw NASA CNEOS CSV (with nested close_approach_data Python-dict strings)
into a flat CSV where every row is one close-approach event for one asteroid.

Run:
    python flatten_asteroids.py

Outputs:
    asteroids_flat.csv  — import this into Power BI
"""

import csv
import ast
import json
import os

INPUT_FILE  = os.path.join(os.path.dirname(__file__), "asteroids_data.csv")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "asteroids_flat.csv")

# Columns to carry forward from the parent asteroid row
PARENT_COLS = [
    "id", "neo_id", "name", "short_name", "designation",
    "magnitude", "potentially_hazardous",
    "diameter_min_m", "diameter_max_m",
    "eccentricity", "semi_major_axis", "inclination",
    "ascending_node_longitude", "orbital_period",
    "perihelion_distance", "perihelion_argument", "aphelion_distance",
    "mean_anomaly", "mean_motion",
    "orbit_class_type", "orbit_class_desc",
    "first_observation_date", "last_observation_date", "data_arc_days",
    "orbit_uncertainty", "min_orbit_intersection", "jupiter_tisserand",
]

OUTPUT_COLS = PARENT_COLS + [
    "close_approach_date",
    "close_approach_date_full",
    "epoch_ms",
    "velocity_km_s",
    "velocity_km_h",
    "miss_distance_au",
    "miss_distance_lunar",
    "miss_distance_km",
    "orbiting_body",
]


def safe_parse_approach(raw: str) -> list:
    """Parse Python-dict-style close_approach_data string into a list of dicts."""
    if not raw or raw.strip() in ("", "[]"):
        return []
    try:
        return ast.literal_eval(raw)
    except Exception:
        pass
    # Fallback: swap single quotes and try JSON
    try:
        fixed = raw.replace("'", '"').replace("None", "null").replace("True", "true").replace("False", "false")
        return json.loads(fixed)
    except Exception as e:
        print(f"  WARNING: could not parse close_approach_data — {e}")
        return []


def flatten():
    rows_written = 0
    errors = 0

    with open(INPUT_FILE, newline="", encoding="utf-8") as fin, \
         open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as fout:

        reader = csv.DictReader(fin)
        writer = csv.DictWriter(fout, fieldnames=OUTPUT_COLS, extrasaction="ignore")
        writer.writeheader()

        for raw_row in reader:
            parent = {col: raw_row.get(col, "") for col in PARENT_COLS}

            approaches = safe_parse_approach(raw_row.get("close_approach_data", ""))

            if not approaches:
                # Still write the asteroid row with blank approach fields so it appears in the visual
                writer.writerow({**parent, **{col: "" for col in OUTPUT_COLS if col not in PARENT_COLS}})
                continue

            for appr in approaches:
                vel  = appr.get("relative_velocity", {})
                dist = appr.get("miss_distance", {})

                out_row = {
                    **parent,
                    "close_approach_date":      appr.get("close_approach_date", ""),
                    "close_approach_date_full": appr.get("close_approach_date_full", ""),
                    "epoch_ms":                 appr.get("epoch_date_close_approach", ""),
                    "velocity_km_s":            vel.get("kilometers_per_second", ""),
                    "velocity_km_h":            vel.get("kilometers_per_hour", ""),
                    "miss_distance_au":         dist.get("astronomical", ""),
                    "miss_distance_lunar":      dist.get("lunar", ""),
                    "miss_distance_km":         dist.get("kilometers", ""),
                    "orbiting_body":            appr.get("orbiting_body", ""),
                }
                writer.writerow(out_row)
                rows_written += 1

    print(f"Done. {rows_written} close-approach rows written to {OUTPUT_FILE}")
    if errors:
        print(f"  {errors} parse errors (check warnings above).")


if __name__ == "__main__":
    flatten()
