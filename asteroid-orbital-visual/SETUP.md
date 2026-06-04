# Asteroid Orbital Map — Setup & Launch

## Step 1 — Flatten the raw data (run once)

```
cd "C:\Users\jdsti\OneDrive\Desktop\Projects\nasa asteroids"
python flatten_asteroids.py
```

This produces `asteroids_flat.csv` — import **this** file into Power BI (not the original).

---

## Step 2 — Install Node.js

Download from https://nodejs.org  → choose the **LTS** version.  
After install, close and re-open your terminal.

---

## Step 3 — Install pbiviz and project dependencies

```powershell
npm install -g powerbi-visuals-tools
cd "C:\Users\jdsti\OneDrive\Desktop\Projects\nasa asteroids\asteroid-orbital-visual"
npm install
```

---

## Step 4 — Trust the developer certificate (first time only)

```powershell
pbiviz --install-cert
```

---

## Step 5 — Enable Developer Mode in Power BI Desktop

File → Options and settings → Options → Security  
✅ Enable custom visual developer mode

---

## Step 6 — Start the dev server

```powershell
pbiviz start
```

The terminal will say **"Server listening on port 8080"**.

---

## Step 7 — Load the visual in Power BI

1. Open Power BI Desktop
2. Import `asteroids_flat.csv` as your data source
3. In the Visualizations pane, click **"..."** → **Import a visual from a file** → pick `asteroid-orbital-visual.pbiviz`  
   *Or* use the **Developer visual** tile (only visible when dev mode is on)
4. Drag the visual onto your canvas

---

## Step 8 — Map the fields

Drag these columns from `asteroids_flat.csv` into the **Data Fields** bucket:

| Column               | What it drives                  |
|----------------------|---------------------------------|
| name                 | Asteroid identity               |
| short_name           | Label                           |
| potentially_hazardous| Red color + pulse               |
| diameter_max_m       | Dot size                        |
| semi_major_axis      | Orbit size                      |
| eccentricity         | Orbit shape                     |
| perihelion_argument  | Orbit orientation               |
| miss_distance_au     | Closest approach distance       |
| close_approach_date  | Approach date (tooltip)         |
| velocity_km_s        | Approach speed (tooltip)        |
| orbiting_body        | Which planet approached         |
| magnitude            | Brightness (tooltip)            |
| orbit_class_type     | Orbit class label (tooltip)     |

---

## Formatting pane options

| Option                  | Default | Effect                              |
|-------------------------|---------|-------------------------------------|
| Show All 8 Planets      | On      | Toggle outer planets                |
| Animation Speed         | 5       | Days simulated per frame            |
| Hazardous Asteroids Only| Off     | Filter to red asteroids only        |

---

## Package for sharing

```powershell
pbiviz package
```

Produces `asteroid-orbital-visual.pbiviz` in `dist/` — share this file.
