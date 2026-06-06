# NASA Close-Approach Asteroids: Visual Models

*A suite of five Power BI custom visuals — animated orbital maps + analytics*

Built from [NASA CNEOS close-approach data](https://cneos.jpl.nasa.gov/ca/). Two animated
solar-system visuals (**2D** and **3D**) show near-Earth asteroids appearing, brightening
toward each close approach, and fading out on a scrubbable 1930–2026 timeline. Three
**analytics** visuals add orbital-family clustering, a value/“catchable” scatter, and a
rigorous planetary-impact table — all driven by the same flattened data table.

![3D solar system with asteroid close-approach orbits and labeled planets](assets/preview.png)

## The five visuals

### Animated orbital maps

| | 2D (`asteroid-orbital-visual`) | 3D (`asteroid-orbital-3d`) |
|---|---|---|
| Engine | D3.js (SVG) | Three.js (WebGL) |
| Orbits | Top-down, log radial scale | True 3D using `inclination` + `ascending_node_longitude` |
| Planets | Glowing colored bodies | **Procedurally textured** globes (craters, cloud bands, ice caps, Saturn’s rings) with real axial tilt + self-rotation |
| Camera | Zoom / pan | Orbit / zoom |

### Analytics

| Visual | Engine | What it shows |
|---|---|---|
| `asteroid-cluster-map` | D3.js | **K-means orbital clustering** (2–8 groups) on semi-major axis, eccentricity & inclination, with 1σ error ellipses. Each group is named by its dominant near-Earth family (Apollo / Aten / Amor / Atira) and labeled with the planets it would actually hit. |
| `asteroid-value-scatter` | D3.js | Velocity vs. miss distance, **sized by diameter**, colored by a value score (`diameter × velocity / distance`). Flags **“catchable”** asteroids (slower than a chosen orbital speed) and the high-value zone. Optional log axes + trend line. |
| `asteroid-impact-table` | D3.js | A table of asteroids ranked by how close they come to **actually striking a body** — not just crossing its orbit. Uses NASA’s propagated miss distance, a gravitational-capture cross-section, and an adjustable orbit-uncertainty envelope. |

## Download & open (no build required)

Grab the [**latest release**](https://github.com/jdstigma/NASA-Close-Approach-Asteroids-Visual-Models/releases/latest):

| Download | What it is |
|---|---|
| `NASA Close Approach Asteroids - Model.pbix` | Open directly in Power BI Desktop — visuals and data already embedded |
| `asteroid-orbital-map-1.0.0.pbiviz` | 2D orbital map |
| `asteroid-orbital-map-3d-1.0.0.pbiviz` | 3D orbital map (textured planets) |
| `asteroid-cluster-map-1.0.0.pbiviz` | Orbital-family clustering |
| `asteroid-value-scatter-1.0.0.pbiviz` | Value / catchable scatter |
| `asteroid-impact-table-1.0.0.pbiviz` | Predicted-impact table |

## Adding the visuals to a report

1. Power BI Desktop → Visualizations pane → **`...` → Import a visual from a file** → pick a `.pbiviz`
2. Add it to a page and drag fields into its **Data Fields** bucket
3. Set every numeric and date field to **Don’t summarize**

> **Tip — map once, not per visual.** All five visuals read from a single generic
> **Data Fields** bucket and pick the columns they need *by name*. The simplest workflow is
> to **drag the entire column set into each visual** — each one grabs what it understands and
> ignores the rest. Just make sure numeric/date fields are set to **Don’t summarize** so the
> table keeps one row per close approach (the impact table and cluster map depend on this).

### Fields each visual needs

| Field | Used by |
|---|---|
| `name`, `short_name`, `potentially_hazardous` | all |
| `semi_major_axis`, `eccentricity`, `perihelion_argument` | orbital maps, cluster |
| `inclination`, `ascending_node_longitude` | 3D map, cluster |
| `diameter_max_m` | scatter (size), tooltips |
| `orbiting_body`, `miss_distance_km` *(or `_au` / `_lunar`)*, `velocity_km_s` *(or `_km_h`)* | **impact table, cluster “hits”, scatter** |
| `orbit_uncertainty` | impact table & cluster error envelope |
| `close_approach_date`, `first_observation_date`, `last_observation_date` | timeline, per-approach rows |
| `min_orbit_intersection`, `magnitude`, `orbit_class_type` | tooltips / labels |

The impact table and cluster map accept any miss-distance variant (km / AU / lunar) and either
velocity unit; if a required field is missing, the visual shows a diagnostic listing exactly
what it detected.

## How the analytics work

**Cluster map.** K-means++ groups asteroids by orbit (semi-major axis, eccentricity,
inclination). Each cluster is labeled by the dominant orbit class — **Apollo** (Earth-crossing,
larger orbit), **Aten** (Earth-crossing, smaller orbit), **Amor** (Mars-crossing, approaches
but doesn’t cross Earth), **Atira** (entirely inside Earth’s orbit) — with its mean orbit and a
1σ dispersion ellipse. Asteroids that would **actually hit** a body (by the same test as the
impact table) get a red ring; the legend reports each group’s hits or its closest approach.

**Value scatter.** Each asteroid’s closest Earth approach plotted as velocity (X) vs. miss
distance (Y, log), sized by diameter and colored by a value score. A **catchable** threshold
(default 28,000 km/h ≈ low-Earth-orbit satellite speed, 7.8 km/s) marks objects slow enough to
plausibly intercept. Dot-size contrast, the speed limit, log axes, and a trend line are all
adjustable in the Format pane.

**Impact table — true-collision test.** For each recorded close approach:

> **impact** ⟺ `miss_distance − error ≤ capture_radius`

- **Miss distance** is NASA’s propagated asteroid-to-body distance *at the encounter instant*,
  so the body’s actual orbital position is already accounted for (no re-deriving planet
  positions from Keplerian elements, which would be less accurate).
- **Capture radius** = `R_body · √(1 + (v_esc / v_ca)²)` — the gravitational-focusing impact
  cross-section (a planet’s gravity bends trajectories inward, enlarging the effective target).
- **Error** = a tunable orbit-uncertainty (OCC) envelope scaled by a σ confidence level.

Each encounter is verdicted **DIRECT HIT / WITHIN ERROR / NEAR MISS**. A note on the result:
**this dataset’s well-tracked orbits contain no collisions at any realistic uncertainty.** The
closest call (1990 VA grazing Venus) would need ~16.5σ of error to reach the capture radius;
Duende and Apophis need ~34σ. So the table honestly reports near misses and ranks the closest
approaches — exactly what the real data supports.

## Repository layout

```
nasa asteroids/
├── asteroids_data.csv            # Raw NASA CNEOS export (nested close_approach_data)
├── asteroids_flat.csv            # Flattened — one row per close approach (import this)
├── flatten_asteroids.py          # Parses the nested data into the flat CSV
├── setup_and_run.ipynb           # Automated setup notebook
├── powerquery_web_connection.m   # Power Query M to load the flat CSV from GitHub
├── make_icon.py / make_icon_3d.py / make_icons_new.py   # Visual icon generators
├── asteroid-orbital-visual/      # 2D orbital map (D3)
├── asteroid-orbital-3d/          # 3D orbital map (Three.js, textured planets)
├── asteroid-cluster-map/         # Orbital-family clustering (D3)
├── asteroid-value-scatter/       # Value / catchable scatter (D3)
├── asteroid-impact-table/        # Predicted-impact table (D3)
├── release/                      # Prebuilt .pbiviz files (also on GitHub Releases)
│   ├── asteroid-orbital-map-1.0.0.pbiviz
│   ├── asteroid-orbital-map-3d-1.0.0.pbiviz
│   ├── asteroid-cluster-map-1.0.0.pbiviz
│   ├── asteroid-value-scatter-1.0.0.pbiviz
│   └── asteroid-impact-table-1.0.0.pbiviz
└── reports/                      # Published Power BI report (via Git LFS)
    └── NASA Close Approach Asteroids - Model.pbix
```

## Build from source

```bash
# Install Node.js LTS, then for any visual folder:
npm install -g powerbi-visuals-tools
cd asteroid-cluster-map        # or any visual folder
npm install
pbiviz package                 # → dist/*.pbiviz
```

## Data source

NASA Near Earth Object Web Service (NeoWs) / CNEOS. The raw `close_approach_data` column is a
nested Python-dict string; `flatten_asteroids.py` expands it into one row per close-approach
event. The `.pbix` report under `reports/` is stored via **Git LFS**.

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE)
