"use strict";

import powerbi from "powerbi-visuals-api";
import * as d3 from "d3";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions    = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual                = powerbi.extensibility.visual.IVisual;
import DataView               = powerbi.DataView;

// ---------------------------------------------------------------------------
// Planet orbital elements (J2000, values in AU / degrees / days)
// ---------------------------------------------------------------------------
interface PlanetDef {
    name:   string;
    color:  string;
    radius: number;   // visual dot radius px
    a:      number;   // semi-major axis AU
    e:      number;   // eccentricity
    period: number;   // orbital period in Earth days
    omega:  number;   // argument of perihelion deg (simplified, no inclination for 2D view)
}

const PLANETS: PlanetDef[] = [
    { name: "Mercury", color: "#b5b5b5", radius: 3,  a: 0.387,  e: 0.206, period: 87.97,    omega: 29.1  },
    { name: "Venus",   color: "#e8cda0", radius: 4,  a: 0.723,  e: 0.007, period: 224.70,   omega: 54.9  },
    { name: "Earth",   color: "#4fa3e0", radius: 5,  a: 1.000,  e: 0.017, period: 365.25,   omega: 102.9 },
    { name: "Mars",    color: "#c1440e", radius: 4,  a: 1.524,  e: 0.093, period: 686.97,   omega: 336.0 },
    { name: "Jupiter", color: "#c88b3a", radius: 9,  a: 5.203,  e: 0.049, period: 4332.59,  omega: 14.3  },
    { name: "Saturn",  color: "#e4d191", radius: 8,  a: 9.537,  e: 0.057, period: 10759.22, omega: 92.4  },
    { name: "Uranus",  color: "#7de8e8", radius: 6,  a: 19.19,  e: 0.046, period: 30685.40, omega: 170.9 },
    { name: "Neptune", color: "#5b73e8", radius: 6,  a: 30.07,  e: 0.010, period: 60190.03, omega: 44.9  },
];

const MAX_AU = 32;          // clip anything beyond this for the full view
const DEG    = Math.PI / 180;

// Column names expected in the flat CSV after data prep
const COL = {
    name:           "name",
    shortName:      "short_name",
    hazardous:      "potentially_hazardous",
    diameterMax:    "diameter_max_m",
    diameterMin:    "diameter_min_m",
    semiMajorAxis:  "semi_major_axis",
    eccentricity:   "eccentricity",
    inclination:    "inclination",
    periArgument:   "perihelion_argument",
    missDistAU:     "miss_distance_au",
    missDistKm:     "miss_distance_km",
    approachDate:   "close_approach_date",
    velocityKmS:    "velocity_km_s",
    orbitingBody:   "orbiting_body",
    magnitude:      "magnitude",
    orbitClass:     "orbit_class_type",
};

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------
interface AsteroidOrbit {
    name:        string;
    shortName:   string;
    hazardous:   boolean;
    diameterM:   number;
    a:           number;   // semi-major axis AU
    e:           number;
    omega:       number;   // perihelion argument deg
    magnitude:   number;
    orbitClass:  string;
    approaches:  ApproachEvent[];
}

interface ApproachEvent {
    date:        string;
    missDistAU:  number;
    velocityKmS: number;
    orbitingBody: string;
}

// ---------------------------------------------------------------------------
// Maths helpers
// ---------------------------------------------------------------------------
function orbitXY(a: number, e: number, omegaDeg: number, trueAnomalyDeg: number): [number, number] {
    const nu = trueAnomalyDeg * DEG;
    const r  = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
    const th = nu + omegaDeg * DEG;
    return [r * Math.cos(th), r * Math.sin(th)];
}

function meanToTrueAnomaly(M: number, e: number, iters = 10): number {
    // Solve Kepler's equation E - e*sin(E) = M  (all in radians)
    let E = M;
    for (let i = 0; i < iters; i++) {
        E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    return nu;
}

function planetTrueAnomaly(planet: PlanetDef, daysSinceJ2000: number): number {
    // Mean anomaly at epoch = 0 (simplified — orbit starts at perihelion)
    const M  = (2 * Math.PI * daysSinceJ2000) / planet.period;
    const Mn = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return meanToTrueAnomaly(Mn, planet.e) / DEG;
}

// Build ellipse path for SVG (orbit ring), accounting for eccentricity
function ellipsePath(a: number, e: number, omegaDeg: number, scale: number, cx: number, cy: number): string {
    const b  = a * Math.sqrt(1 - e * e);
    const fd = a * e;   // focus offset
    const pts: [number, number][] = [];
    const steps = 180;
    for (let i = 0; i <= steps; i++) {
        const nu = (i / steps) * 2 * Math.PI;
        const r  = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
        const th = nu + omegaDeg * DEG;
        pts.push([cx + r * Math.cos(th) * scale, cy - r * Math.sin(th) * scale]);
    }
    return "M " + pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L ") + " Z";
}

// ---------------------------------------------------------------------------
// Visual class
// ---------------------------------------------------------------------------
export class Visual implements IVisual {
    private host:       powerbi.extensibility.visual.IVisualHost;
    private container:  d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private svg:        d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private planetLayer:   d3.Selection<SVGGElement, unknown, null, undefined>;
    private asteroidLayer: d3.Selection<SVGGElement, unknown, null, undefined>;
    private labelLayer:    d3.Selection<SVGGElement, unknown, null, undefined>;
    private infoBox:    d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private legend:     d3.Selection<HTMLDivElement, unknown, null, undefined>;

    private width:  number = 800;
    private height: number = 800;
    private scale:  number = 1;
    private cx:     number = 400;
    private cy:     number = 400;

    private asteroids: AsteroidOrbit[] = [];
    private animFrame: number | null   = null;
    private daysSinceJ2000: number     = 0;
    private animSpeed: number          = 5;   // days per animation frame
    private showHazardousOnly: boolean = false;
    private showAllPlanets: boolean    = true;

    // Simulation clock bounds (days since J2000). The animation loops between these
    // instead of running forever; derived from the data's close-approach date range.
    private simMinDays: number = -36525;   // default ~1900
    private simMaxDays: number =  73050;   // default ~2200

    // J2000 = 2000-Jan-01.5  →  Unix ms
    private readonly J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;

        this.container = d3.select(options.element)
            .append("div")
            .classed("orbital-container", true)
            .style("position", "relative")
            .style("width", "100%")
            .style("height", "100%")
            .style("background", "#050510")
            .style("overflow", "hidden");

        this.svg = this.container.append("svg")
            .classed("orbital-svg", true)
            .style("width", "100%")
            .style("height", "100%");

        // Background
        this.svg.append("rect")
            .classed("bg", true)
            .attr("x", 0).attr("y", 0)
            .attr("width", "100%").attr("height", "100%")
            .attr("fill", "#050510");

        // Star field (static random dots)
        const starG = this.svg.append("g").classed("stars", true);
        for (let i = 0; i < 250; i++) {
            starG.append("circle")
                .attr("cx", Math.random() * 2000)
                .attr("cy", Math.random() * 2000)
                .attr("r",  Math.random() < 0.9 ? 0.6 : 1.2)
                .attr("fill", `rgba(255,255,255,${(0.3 + Math.random() * 0.7).toFixed(2)})`);
        }

        this.planetLayer   = this.svg.append("g").classed("planets",   true);
        this.asteroidLayer = this.svg.append("g").classed("asteroids", true);
        this.labelLayer    = this.svg.append("g").classed("labels",    true);

        // Sun
        this.svg.append("circle")
            .classed("sun", true)
            .attr("r", 10)
            .attr("fill", "#ffe484")
            .attr("filter", "url(#sunGlow)");

        // Sun glow filter
        const defs = this.svg.append("defs");
        const filter = defs.append("filter").attr("id", "sunGlow").attr("x", "-100%").attr("y", "-100%").attr("width", "300%").attr("height", "300%");
        filter.append("feGaussianBlur").attr("stdDeviation", "6").attr("result", "blur");
        const merge = filter.append("feMerge");
        merge.append("feMergeNode").attr("in", "blur");
        merge.append("feMergeNode").attr("in", "SourceGraphic");

        // Pulse filter for close approaches
        const pulseFilter = defs.append("filter").attr("id", "pulse").attr("x", "-200%").attr("y", "-200%").attr("width", "500%").attr("height", "500%");
        pulseFilter.append("feGaussianBlur").attr("stdDeviation", "4").attr("result", "blur");
        const pm = pulseFilter.append("feMerge");
        pm.append("feMergeNode").attr("in", "blur");
        pm.append("feMergeNode").attr("in", "SourceGraphic");

        // Info box (bottom-left)
        this.infoBox = this.container.append("div")
            .classed("info-box", true)
            .style("position", "absolute")
            .style("bottom", "8px")
            .style("left",   "8px")
            .style("color", "#ccc")
            .style("font-size", "11px")
            .style("font-family", "monospace")
            .style("background", "rgba(0,0,0,0.6)")
            .style("padding", "6px 10px")
            .style("border-radius", "4px")
            .style("pointer-events", "none");

        // Legend (top-right)
        this.legend = this.container.append("div")
            .classed("legend", true)
            .style("position", "absolute")
            .style("top",   "8px")
            .style("right", "8px")
            .style("color", "#ccc")
            .style("font-size", "11px")
            .style("font-family", "sans-serif")
            .style("background", "rgba(0,0,0,0.6)")
            .style("padding", "8px 12px")
            .style("border-radius", "4px")
            .style("line-height", "1.8");

        this.legend.html(`
            <div style="font-weight:bold;margin-bottom:4px;color:#fff">Asteroid Orbital Map</div>
            <div><span style="color:#ff4444">●</span> Potentially Hazardous</div>
            <div><span style="color:#aaaaaa">●</span> Non-Hazardous</div>
            <div><span style="color:#ffe484">●</span> Sun</div>
            <div style="margin-top:4px;color:#888;font-size:10px">Hover asteroid for details</div>
        `);

        // Start current sim time roughly at today
        this.daysSinceJ2000 = (Date.now() - this.J2000_MS) / 86400000;
        this.startAnimation();
    }

    // -----------------------------------------------------------------------
    public update(options: VisualUpdateOptions): void {
        this.width  = options.viewport.width;
        this.height = options.viewport.height;

        this.svg
            .attr("width",  this.width)
            .attr("height", this.height);

        // Size the background rect explicitly (percentage sizing can fail on first render)
        this.svg.select(".bg")
            .attr("width",  this.width)
            .attr("height", this.height);

        this.cx = this.width  / 2;
        this.cy = this.height / 2;
        this.scale = Math.min(this.width, this.height) / 2 / MAX_AU;

        // Reposition the sun
        this.svg.select(".sun")
            .attr("cx", this.cx)
            .attr("cy", this.cy);

        // Empty-state message when no data has been mapped yet
        const hasData = !!(options.dataViews && options.dataViews[0] && options.dataViews[0].table
            && options.dataViews[0].table.rows.length > 0);
        this.svg.selectAll(".empty-msg").remove();
        if (!hasData) {
            this.svg.append("text")
                .classed("empty-msg", true)
                .attr("x", this.cx)
                .attr("y", this.height - 24)
                .attr("text-anchor", "middle")
                .attr("fill", "#8899bb")
                .attr("font-family", "sans-serif")
                .attr("font-size", "13px")
                .text("Drag asteroid fields into the Data Fields bucket to plot orbits");
        }

        // Read formatting settings
        if (options.dataViews && options.dataViews[0]) {
            const objs = options.dataViews[0].metadata?.objects;
            if (objs) {
                this.showAllPlanets    = (objs["display"]?.["showAllPlanets"]    as boolean) ?? true;
                this.showHazardousOnly = (objs["display"]?.["showHazardousOnly"] as boolean) ?? false;
                this.animSpeed         = (objs["display"]?.["animationSpeed"]    as number)  ?? 5;
            }
            this.parseData(options.dataViews[0]);
        }

        this.drawPlanetOrbits();
        this.drawAsteroidOrbits();
    }

    // -----------------------------------------------------------------------
    private parseData(dataView: DataView): void {
        this.asteroids = [];
        if (!dataView.table) return;

        const cols  = dataView.table.columns;
        const rows  = dataView.table.rows;

        // Normalize a column name so matching survives aggregation wrappers
        // e.g. "Sum(Asteroids.semi_major_axis)" or "Sum of semi_major_axis" -> "semi_major_axis"
        const normalize = (raw: string): string =>
            (raw || "")
                .toLowerCase()
                .replace(/^(sum|count|countnonnull|average|avg|min|max|median|first|last|var|stdev) of /, "")
                .split(".").pop()!            // last dotted segment
                .replace(/[^a-z0-9_]/g, "");  // drop parentheses / stray chars

        // Build column index map keyed by normalized name (prefer displayName, fall back to queryName)
        const idx: Record<string, number> = {};
        cols.forEach((c, i) => {
            const keyDisplay = normalize(c.displayName);
            const keyQuery   = normalize(c.queryName);
            if (keyDisplay && !(keyDisplay in idx)) idx[keyDisplay] = i;
            if (keyQuery   && !(keyQuery   in idx)) idx[keyQuery]   = i;
        });

        const getStr = (row: powerbi.DataViewTableRow, name: string): string =>
            String(row[idx[name.toLowerCase()]] ?? "").trim();
        const getNum = (row: powerbi.DataViewTableRow, name: string): number =>
            parseFloat(getStr(row, name)) || 0;

        // Group rows by asteroid name (each row = one close approach)
        const map = new Map<string, AsteroidOrbit>();

        for (const row of rows) {
            const name      = getStr(row, COL.name);
            const shortName = getStr(row, COL.shortName) || name;
            if (!name) continue;

            if (!map.has(name)) {
                map.set(name, {
                    name,
                    shortName,
                    hazardous:  getStr(row, COL.hazardous).toLowerCase() === "true",
                    diameterM:  getNum(row, COL.diameterMax),
                    a:          getNum(row, COL.semiMajorAxis),
                    e:          getNum(row, COL.eccentricity),
                    omega:      getNum(row, COL.periArgument),
                    magnitude:  getNum(row, COL.magnitude),
                    orbitClass: getStr(row, COL.orbitClass),
                    approaches: [],
                });
            }

            const missAU = getNum(row, COL.missDistAU);
            if (missAU > 0) {
                map.get(name)!.approaches.push({
                    date:        getStr(row, COL.approachDate),
                    missDistAU:  missAU,
                    velocityKmS: getNum(row, COL.velocityKmS),
                    orbitingBody: getStr(row, COL.orbitingBody),
                });
            }
        }

        this.asteroids = Array.from(map.values()).filter(a => a.a > 0 && a.e < 1);

        // Derive the simulation clock range from the actual close-approach dates,
        // so the animation loops over the data window instead of counting up forever.
        let minMs = Infinity, maxMs = -Infinity;
        for (const ast of this.asteroids) {
            for (const ap of ast.approaches) {
                const ms = Date.parse(ap.date);
                if (!isNaN(ms)) {
                    if (ms < minMs) minMs = ms;
                    if (ms > maxMs) maxMs = ms;
                }
            }
        }
        if (isFinite(minMs) && isFinite(maxMs) && maxMs > minMs) {
            this.simMinDays = (minMs - this.J2000_MS) / 86400000;
            this.simMaxDays = (maxMs - this.J2000_MS) / 86400000;
            // Start the clock at the beginning of the data window
            this.daysSinceJ2000 = this.simMinDays;
        }
    }

    // -----------------------------------------------------------------------
    private drawPlanetOrbits(): void {
        this.planetLayer.selectAll("*").remove();

        const planets = this.showAllPlanets ? PLANETS : PLANETS.slice(0, 4);

        // Orbit rings
        planets.forEach(p => {
            const path = ellipsePath(p.a, p.e, p.omega, this.scale, this.cx, this.cy);
            this.planetLayer.append("path")
                .attr("d", path)
                .attr("fill", "none")
                .attr("stroke", p.color)
                .attr("stroke-opacity", 0.25)
                .attr("stroke-width", 0.8);
        });

        // Planet labels (static positions at current angle for clarity)
        planets.forEach(p => {
            const labelAngle = 45 * DEG;
            const r = p.a * this.scale;
            const lx = this.cx + r * Math.cos(labelAngle);
            const ly = this.cy - r * Math.sin(labelAngle);

            this.planetLayer.append("text")
                .attr("x", lx + 4)
                .attr("y", ly - 4)
                .attr("fill", p.color)
                .attr("font-size", p.radius > 6 ? "10px" : "8px")
                .attr("font-family", "sans-serif")
                .attr("opacity", 0.6)
                .text(p.name);
        });
    }

    // -----------------------------------------------------------------------
    private drawAsteroidOrbits(): void {
        this.asteroidLayer.selectAll("*").remove();

        const visibleAsteroids = this.showHazardousOnly
            ? this.asteroids.filter(a => a.hazardous)
            : this.asteroids;

        visibleAsteroids.forEach(asteroid => {
            if (asteroid.a > MAX_AU) return;

            const color = asteroid.hazardous ? "#ff4444" : "#888888";
            const path  = ellipsePath(asteroid.a, asteroid.e, asteroid.omega, this.scale, this.cx, this.cy);

            this.asteroidLayer.append("path")
                .attr("d", path)
                .attr("fill", "none")
                .attr("stroke", color)
                .attr("stroke-opacity", asteroid.hazardous ? 0.35 : 0.18)
                .attr("stroke-width", asteroid.hazardous ? 0.8 : 0.5)
                .attr("stroke-dasharray", asteroid.hazardous ? "none" : "2,4");
        });
    }

    // -----------------------------------------------------------------------
    private startAnimation(): void {
        const tick = () => {
            this.daysSinceJ2000 += this.animSpeed;
            // Loop back to the start of the data window instead of advancing forever
            if (this.daysSinceJ2000 > this.simMaxDays) {
                this.daysSinceJ2000 = this.simMinDays;
            }
            this.updateMovingBodies();
            this.animFrame = requestAnimationFrame(tick);
        };
        this.animFrame = requestAnimationFrame(tick);
    }

    // -----------------------------------------------------------------------
    private updateMovingBodies(): void {
        if (!this.svg || this.width === 0) return;

        const planets = this.showAllPlanets ? PLANETS : PLANETS.slice(0, 4);

        // Update planet dot positions
        const planetDots = this.planetLayer.selectAll<SVGCircleElement, PlanetDef>("circle.planet-dot")
            .data(planets, d => d.name);

        const self = this;

        planetDots.enter()
            .append("circle")
            .classed("planet-dot", true)
            .attr("r", d => d.radius)
            .attr("fill", d => d.color)
            .on("mouseover", function(event, d) {
                self.showTooltip(d.name, event.clientX, event.clientY);
            })
            .on("mouseout",  () => self.hideTooltip())
            .merge(planetDots)
            .each(function(d) {
                const nu = planetTrueAnomaly(d, self.daysSinceJ2000);
                const [x, y] = orbitXY(d.a, d.e, d.omega, nu);
                d3.select(this)
                    .attr("cx", self.cx + x * self.scale)
                    .attr("cy", self.cy - y * self.scale);
            });

        planetDots.exit().remove();

        // Update asteroid dot positions
        const visibleAsteroids = (this.showHazardousOnly
            ? this.asteroids.filter(a => a.hazardous)
            : this.asteroids
        ).filter(a => a.a > 0 && a.a <= MAX_AU);

        // Compute asteroid true anomaly based on period derived from semi-major axis (Kepler's 3rd law)
        // Period (days) = 365.25 * a^1.5  (for a in AU, relative to Sun's mass)
        const asteroidDots = this.asteroidLayer.selectAll<SVGCircleElement, AsteroidOrbit>("circle.asteroid-dot")
            .data(visibleAsteroids, d => d.name);

        asteroidDots.enter()
            .append("circle")
            .classed("asteroid-dot", true)
            .attr("r", d => {
                const base = d.hazardous ? 3.5 : 2;
                if (!d.diameterM) return base;
                return Math.min(6, base + Math.log10(d.diameterM + 1) * 0.5);
            })
            .attr("fill", d => d.hazardous ? "#ff6666" : "#aaaaaa")
            .attr("filter", d => d.hazardous ? "url(#pulse)" : "none")
            .attr("cursor", "pointer")
            .on("mouseover", function(event, d) {
                const nearApproach = self.closestApproachToEarth(d);
                self.showAsteroidTooltip(d, nearApproach, event.clientX, event.clientY);
                d3.select(this).attr("r", parseFloat(d3.select(this).attr("r")) * 1.8);
            })
            .on("mouseout",  function(event, d) {
                const base = d.hazardous ? 3.5 : 2;
                const r = !d.diameterM ? base : Math.min(6, base + Math.log10(d.diameterM + 1) * 0.5);
                d3.select(this).attr("r", r);
                self.hideTooltip();
            })
            .merge(asteroidDots)
            .each(function(d) {
                const period = 365.25 * Math.pow(d.a, 1.5);
                const M      = (2 * Math.PI * self.daysSinceJ2000) / period;
                const Mn     = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                const nu     = meanToTrueAnomaly(Mn, d.e) / DEG;
                const [x, y] = orbitXY(d.a, d.e, d.omega, nu);
                d3.select(this)
                    .attr("cx", self.cx + x * self.scale)
                    .attr("cy", self.cy - y * self.scale);
            });

        asteroidDots.exit().remove();

        // Update sim date readout
        const simDate = new Date(this.J2000_MS + this.daysSinceJ2000 * 86400000);
        this.infoBox.html(
            `Sim date: ${simDate.getFullYear()}-${String(simDate.getMonth()+1).padStart(2,"0")}-${String(simDate.getDate()).padStart(2,"0")}<br>` +
            `Asteroids: ${visibleAsteroids.length} | Speed: ${this.animSpeed} days/frame`
        );
    }

    // -----------------------------------------------------------------------
    private closestApproachToEarth(asteroid: AsteroidOrbit): ApproachEvent | null {
        const earthApproaches = asteroid.approaches.filter(a => a.orbitingBody === "Earth");
        if (earthApproaches.length === 0) return asteroid.approaches[0] ?? null;
        return earthApproaches.reduce((best, a) => a.missDistAU < best.missDistAU ? a : best);
    }

    // -----------------------------------------------------------------------
    private tooltip: d3.Selection<HTMLDivElement, unknown, null, undefined> | null = null;

    private ensureTooltip(): d3.Selection<HTMLDivElement, unknown, null, undefined> {
        if (!this.tooltip) {
            this.tooltip = d3.select(document.body)
                .append("div")
                .classed("asteroid-tooltip", true)
                .style("position", "fixed")
                .style("background", "rgba(5,5,20,0.92)")
                .style("color", "#eee")
                .style("border", "1px solid #334")
                .style("border-radius", "6px")
                .style("padding", "8px 12px")
                .style("font-family", "monospace")
                .style("font-size", "12px")
                .style("pointer-events", "none")
                .style("line-height", "1.6")
                .style("max-width", "260px")
                .style("display", "none")
                .style("z-index", "9999");
        }
        return this.tooltip;
    }

    private showTooltip(text: string, x: number, y: number): void {
        this.ensureTooltip()
            .style("display", "block")
            .style("left",  (x + 14) + "px")
            .style("top",   (y - 10) + "px")
            .html(text);
    }

    private showAsteroidTooltip(asteroid: AsteroidOrbit, approach: ApproachEvent | null, x: number, y: number): void {
        const hazardLabel = asteroid.hazardous
            ? `<span style="color:#ff6666">⚠ POTENTIALLY HAZARDOUS</span><br>`
            : "";
        const approachHtml = approach
            ? `<br><b>Closest Earth approach:</b><br>` +
              `  Date: ${approach.date}<br>` +
              `  Miss dist: ${approach.missDistAU.toFixed(4)} AU<br>` +
              `  Velocity: ${approach.velocityKmS} km/s`
            : "";

        this.showTooltip(
            `${hazardLabel}` +
            `<b>${asteroid.name}</b><br>` +
            `Class: ${asteroid.orbitClass}<br>` +
            `Semi-major axis: ${asteroid.a.toFixed(3)} AU<br>` +
            `Eccentricity: ${asteroid.e.toFixed(4)}<br>` +
            `Diam (max): ${asteroid.diameterM ? asteroid.diameterM.toFixed(0) + " m" : "unknown"}<br>` +
            `Magnitude: ${asteroid.magnitude}` +
            approachHtml,
            x, y
        );
    }

    private hideTooltip(): void {
        this.tooltip?.style("display", "none");
    }

    // -----------------------------------------------------------------------
    public destroy(): void {
        if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
        this.tooltip?.remove();
    }
}
