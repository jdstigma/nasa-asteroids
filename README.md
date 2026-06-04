# NASA Asteroids — Orbital Map Power BI Custom Visual

An animated 2D solar system Power BI custom visual built from [NASA CNEOS close-approach data](https://cneos.jpl.nasa.gov/ca/). Every asteroid gets its real elliptical orbit drawn from Keplerian elements, planets animate at correct relative speeds, and hazardous objects pulse red.

![Visual preview — animated solar system with asteroid orbits](assets/preview_placeholder.png)

## Features

- **All 8 planets** orbiting the Sun using real semi-major axes and eccentricities
- **Asteroid orbits** drawn from `semi_major_axis`, `eccentricity`, and `perihelion_argument`
- **Hazardous asteroids** highlighted in red with a glow + pulse effect
- **Hover tooltips** showing orbit class, diameter, closest Earth approach date, miss distance, and velocity
- **Formatting pane** controls: animation speed, inner-only vs. all planets, hazard filter
- Power BI slicer-compatible — filter by asteroid, date, hazard status from the report canvas

## Data Source

Raw data: NASA Near Earth Object Web Service (NeoWs) / CNEOS  
File: `asteroids_data.csv` (not committed — add your own export)

The `close_approach_data` column is a nested Python-dict string. Run the prep script to flatten it before loading into Power BI.

## Quick Start

### 1. Flatten the data
```bash
python flatten_asteroids.py
# → produces asteroids_flat.csv (import this into Power BI)
```

### 2. Or use the Jupyter notebook (automated)
```bash
jupyter notebook setup_and_run.ipynb
```
The notebook handles flattening, Node verification, pbiviz install, certificate trust, and dev server launch in sequence.

### 3. Manual setup
```bash
# Install Node.js LTS from https://nodejs.org first, then:
npm install -g powerbi-visuals-tools
cd asteroid-orbital-visual
npm install
pbiviz --install-cert
pbiviz start
```

Enable **Developer Mode** in Power BI Desktop:  
File → Options → Security → ✅ Enable custom visual developer mode

### 4. Map these fields in Power BI

| Column | Role |
|---|---|
| `name` | Asteroid identity |
| `potentially_hazardous` | Color (red = hazardous) |
| `diameter_max_m` | Dot size |
| `semi_major_axis` | Orbit radius |
| `eccentricity` | Orbit shape |
| `perihelion_argument` | Orbit orientation |
| `miss_distance_au` | Closest approach (tooltip) |
| `close_approach_date` | Date (tooltip) |
| `velocity_km_s` | Speed (tooltip) |
| `orbit_class_type` | Class label (tooltip) |

### 5. Package for distribution
```bash
cd asteroid-orbital-visual
pbiviz package
# → dist/asteroid-orbital-visual.pbiviz
```

## Project Structure

```
nasa asteroids/
├── asteroids_data.csv            # Raw NASA source (not committed)
├── asteroids_flat.csv            # Flattened output (generated)
├── flatten_asteroids.py          # Data prep script
├── setup_and_run.ipynb           # Automated setup notebook
└── asteroid-orbital-visual/
    ├── pbiviz.json               # Visual metadata
    ├── capabilities.json         # Power BI data roles
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── visual.ts             # D3 orbital animation (main)
    │   └── settings.ts           # Formatting pane
    └── style/
        └── visual.less           # Dark space theme
```

## Tech Stack

- [Power BI Visuals SDK](https://github.com/microsoft/PowerBI-visuals-tools) v5
- [D3.js](https://d3js.org) v7
- TypeScript

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE)
