"use strict";

import powerbi from "powerbi-visuals-api";
import * as d3 from "d3";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualSettings } from "./settings";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions       = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual                   = powerbi.extensibility.visual.IVisual;
import DataView                  = powerbi.DataView;

// Distinct space-themed cluster colors
const CLUSTER_COLORS = [
    "#4fc3f7", "#ff8a65", "#a5d6a7", "#ce93d8",
    "#fff176", "#f48fb1", "#80deea", "#ffcc80",
];

// Near-Earth orbit-class codes → human-readable family name + one-line meaning.
const ORBIT_CLASS: Record<string, { name: string; desc: string }> = {
    APO: { name: "Apollo", desc: "Earth-crossing, orbit larger than Earth's" },
    ATE: { name: "Aten",   desc: "Earth-crossing, orbit smaller than Earth's" },
    AMO: { name: "Amor",   desc: "Earth-approaching, crosses Mars not Earth" },
    IEO: { name: "Atira",  desc: "orbit entirely inside Earth's" },
    ATI: { name: "Atira",  desc: "orbit entirely inside Earth's" },
};

// ---------------------------------------------------------------------------
// Actual-collision physics — identical to the Impact Table so the two visuals
// agree on what "would hit a planet" means (not mere orbit intersection).
//   impact ⟺ miss_distance − error ≤ capture_radius
// ---------------------------------------------------------------------------
interface BodyDef { radiusKm: number; vEsc: number; }
const BODIES: Record<string, BodyDef> = {
    Mercury: { radiusKm: 2439.7, vEsc: 4.25  },
    Venus:   { radiusKm: 6051.8, vEsc: 10.36 },
    Earth:   { radiusKm: 6371.0, vEsc: 11.19 },
    Moon:    { radiusKm: 1737.4, vEsc: 2.38  },
    Mars:    { radiusKm: 3389.5, vEsc: 5.03  },
    Jupiter: { radiusKm: 69911,  vEsc: 59.5  },
};
const BODY_ALIAS: Record<string, string> = {
    "Earth": "Earth", "Moon": "Moon", "Mars": "Mars",
    "Merc": "Mercury", "Venus": "Venus", "Juptr": "Jupiter",
};

const AU_KM = 149597870.7;   // 1 astronomical unit in km
const LD_KM = 384400;        // 1 lunar distance in km

// Ordinary-least-squares fit in plot (pixel) space → straight on screen for any
// axis scaling. Returns py = m·px + b and R².
function fitLinePx(pts: { x: number; y: number }[]): { m: number; b: number; r2: number } | null {
    const n = pts.length;
    if (n < 3) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return null;
    const m = (n * sxy - sx * sy) / den;
    const b = (sy - m * sx) / n;
    const rDen = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    const r = rDen !== 0 ? (n * sxy - sx * sy) / rDen : 0;
    return { m, b, r2: r * r };
}

// Gravitational capture (impact cross-section) radius: R·√(1 + (v_esc/v_ca)²).
function captureRadiusKm(body: BodyDef, vCa: number): number {
    return vCa > 0 ? body.radiusKm * Math.sqrt(1 + (body.vEsc / vCa) ** 2) : body.radiusKm;
}
// Positional uncertainty at σ: 2% · (OCC+1) · σ of the miss distance.
function errorKm(missKm: number, occ: number, sigma: number): number {
    return missKm * 0.02 * (occ + 1) * sigma;
}

interface AsteroidPoint {
    name:        string;
    shortName:   string;
    hazardous:   boolean;
    sma:         number;   // semi_major_axis AU
    ecc:         number;   // eccentricity
    inc:         number;   // inclination degrees
    orbitClass:  string;
    diameterM:   number;
    // Actual-collision analysis (from close-approach rows):
    hits:        string[]; // bodies it would strike within σ (miss−error ≤ capture R)
    closestBody: string;   // body it comes nearest to hitting
    closestProx: number;   // (miss−error)/capture at that closest approach (≤1 ⇒ hit)
    hasApproachData: boolean;
}

// Per-cluster summary used for descriptive labels & the legend.
interface ClusterInfo {
    idx:          number;
    color:        string;
    family:       string;     // dominant orbit-class family name
    label:        string;     // short on-plot/legend label (family, disambiguated)
    meanA:        number;
    meanE:        number;
    meanI:        number;
    count:        number;
    hazCount:     number;
    impactorCount: number;             // members that would hit some body within σ
    hitBodies:    { body: string; n: number }[]; // bodies actually struck, with counts
    closestBody:  string;              // body the cluster comes nearest to hitting
    hasApproachData: boolean;
}

// Summarise each cluster: dominant orbit family, mean orbit, planets crossed.
// Clusters sharing a family are disambiguated by an inclination tier so two
// "Apollo" groups read as "Apollo (low-i)" / "Apollo (high-i)".
function computeClusters(pool: AsteroidPoint[], labels: number[], k: number): ClusterInfo[] {
    const infos: ClusterInfo[] = [];
    for (let c = 0; c < k; c++) {
        const members = pool.filter((_, i) => labels[i] === c);
        if (members.length === 0) continue;
        const mean = (f: (a: AsteroidPoint) => number) =>
            members.reduce((s, a) => s + f(a), 0) / members.length;
        const meanA = mean(a => a.sma), meanE = mean(a => a.ecc), meanI = mean(a => a.inc);

        const tally = new Map<string, number>();
        for (const m of members) tally.set(m.orbitClass, (tally.get(m.orbitClass) || 0) + 1);
        let domCode = "", best = -1;
        for (const [code, n] of tally) if (n > best) { best = n; domCode = code; }
        const family = ORBIT_CLASS[domCode]?.name ?? (domCode || "Mixed");

        // Aggregate actual-collision results across the cluster's members.
        const hitTally = new Map<string, number>();
        let impactorCount = 0, closestBody = "", bestProx = Infinity;
        for (const m of members) {
            if (m.hits.length > 0) impactorCount++;
            for (const b of m.hits) hitTally.set(b, (hitTally.get(b) || 0) + 1);
            if (m.hasApproachData && m.closestProx < bestProx) {
                bestProx = m.closestProx; closestBody = m.closestBody;
            }
        }
        const hitBodies = [...hitTally.entries()]
            .map(([body, n]) => ({ body, n }))
            .sort((a, b) => b.n - a.n);

        infos.push({
            idx: c, color: CLUSTER_COLORS[c % CLUSTER_COLORS.length],
            family, label: family, meanA, meanE, meanI,
            count: members.length,
            hazCount: members.filter(m => m.hazardous).length,
            impactorCount, hitBodies, closestBody,
            hasApproachData: members.some(m => m.hasApproachData),
        });
    }
    // Disambiguate duplicate family names by inclination tier.
    const byFamily = new Map<string, ClusterInfo[]>();
    for (const ci of infos) {
        const arr = byFamily.get(ci.family) ?? [];
        arr.push(ci); byFamily.set(ci.family, arr);
    }
    for (const arr of byFamily.values()) {
        if (arr.length < 2) continue;
        for (const ci of arr) {
            const tier = ci.meanI < 10 ? "low-i" : ci.meanI < 25 ? "mid-i" : "high-i";
            ci.label = `${ci.family} (${tier})`;
        }
    }
    return infos;
}

// ---------------------------------------------------------------------------
// K-means++ initialisation
// ---------------------------------------------------------------------------
function kMeansPlusPlus(points: number[][], k: number): number[][] {
    const n = points.length;
    const centroids: number[][] = [];
    centroids.push([...points[Math.floor(Math.random() * n)]]);

    for (let c = 1; c < k; c++) {
        const dists = points.map(p => {
            let minD2 = Infinity;
            for (const cent of centroids) {
                const d2 = p.reduce((s, v, i) => s + (v - cent[i]) ** 2, 0);
                if (d2 < minD2) minD2 = d2;
            }
            return minD2;
        });
        const total = dists.reduce((s, d) => s + d, 0);
        let r = Math.random() * total;
        let chosen = n - 1;
        for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { chosen = i; break; } }
        centroids.push([...points[chosen]]);
    }
    return centroids;
}

function kMeans(points: number[][], k: number, iters = 30): { labels: number[], centroids: number[][] } {
    if (points.length === 0) return { labels: [], centroids: [] };
    k = Math.min(k, points.length);
    const centroids = kMeansPlusPlus(points, k);
    const labels    = new Array(points.length).fill(0);

    for (let iter = 0; iter < iters; iter++) {
        let changed = false;
        for (let i = 0; i < points.length; i++) {
            let minD = Infinity, best = 0;
            for (let j = 0; j < k; j++) {
                const d = points[i].reduce((s, v, dim) => s + (v - centroids[j][dim]) ** 2, 0);
                if (d < minD) { minD = d; best = j; }
            }
            if (labels[i] !== best) { labels[i] = best; changed = true; }
        }
        if (!changed && iter > 0) break;

        for (let j = 0; j < k; j++) {
            const members = points.filter((_, i) => labels[i] === j);
            if (members.length > 0) {
                const dim = members[0].length;
                centroids[j] = Array.from({ length: dim }, (_, d) =>
                    members.reduce((s, p) => s + p[d], 0) / members.length
                );
            }
        }
    }
    return { labels, centroids };
}

// ---------------------------------------------------------------------------
// 2×2 covariance eigendecomposition → SVG ellipse params (screen-space)
// Returns null when fewer than 3 members.
// ---------------------------------------------------------------------------
interface EllipseParams { cx: number; cy: number; rx: number; ry: number; angleDeg: number; }

function clusterEllipse(xs: number[], ys: number[]): EllipseParams | null {
    const n = xs.length;
    if (n < 3) return null;

    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    sxx /= n; sxy /= n; syy /= n;

    // Eigenvalues of [[sxx,sxy],[sxy,syy]]
    const tr   = sxx + syy;
    const det  = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, (tr / 2) ** 2 - det));
    const l1   = tr / 2 + disc;
    const l2   = tr / 2 - disc;

    // Eigenvector angle for l1 (rotation of ellipse major axis)
    const angle = Math.abs(sxy) > 1e-10
        ? Math.atan2(l1 - sxx, sxy)
        : (sxx >= syy ? 0 : Math.PI / 2);

    return {
        cx:       mx,
        cy:       my,
        rx:       2 * Math.sqrt(Math.max(0, l1)),   // 2σ major
        ry:       2 * Math.sqrt(Math.max(0, l2)),   // 2σ minor
        angleDeg: angle * 180 / Math.PI,
    };
}

// ---------------------------------------------------------------------------
// Visual
// ---------------------------------------------------------------------------
export class Visual implements IVisual {
    private host:                     powerbi.extensibility.visual.IVisualHost;
    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings:        VisualSettings;
    private container:                 d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private svg:                       d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private tooltip:                   d3.Selection<HTMLDivElement, unknown, null, undefined> | null = null;

    private width  = 800;
    private height = 600;
    private readonly M = { top: 52, right: 210, bottom: 58, left: 68 };

    private asteroids: AsteroidPoint[] = [];
    private rowCount = 0;        // rows received in the last dataView (before filtering)

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.formattingSettingsService = new FormattingSettingsService();
        this.formattingSettings        = new VisualSettings();

        this.container = d3.select(options.element)
            .append("div")
            .style("position", "relative")
            .style("width", "100%")
            .style("height", "100%")
            .style("background", "#050510")
            .style("overflow", "hidden");

        this.svg = this.container.append("svg")
            .style("width", "100%")
            .style("height", "100%");
    }

    // -----------------------------------------------------------------------
    public update(options: VisualUpdateOptions): void {
        this.width  = options.viewport.width;
        this.height = options.viewport.height;
        this.svg.attr("width", this.width).attr("height", this.height);

        if (options.dataViews?.[0]) {
            this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(
                VisualSettings, options.dataViews[0]);
            this.parseData(options.dataViews[0]);
        }
        this.render();
    }

    // -----------------------------------------------------------------------
    private parseData(dataView: DataView): void {
        this.asteroids = [];
        this.rowCount = 0;
        if (!dataView.table) return;
        this.rowCount = dataView.table.rows.length;

        const normalize = (raw: string): string =>
            (raw || "").toLowerCase()
                .replace(/^(sum|count|countnonnull|average|avg|min|max|first|last) of /, "")
                .split(".").pop()!
                .replace(/[^a-z0-9_]/g, "");

        const idx: Record<string, number> = {};
        dataView.table.columns.forEach((c, i) => {
            const k1 = normalize(c.displayName), k2 = normalize(c.queryName);
            if (k1 && !(k1 in idx)) idx[k1] = i;
            if (k2 && !(k2 in idx)) idx[k2] = i;
        });

        const getStr = (row: powerbi.DataViewTableRow, name: string): string =>
            String(row[idx[name]] ?? "").trim();
        const getNum = (row: powerbi.DataViewTableRow, name: string): number =>
            parseFloat(getStr(row, name)) || 0;

        const sigma = Math.max(0, Math.min(9, this.formattingSettings.display.sigmaLevel.value));

        // Single pass over every close-approach row: capture each asteroid's orbital
        // elements once, and fold in the actual-collision test for each approach so
        // "would hit a planet" matches the Impact Table exactly.
        const map = new Map<string, AsteroidPoint>();
        for (const row of dataView.table.rows) {
            const name = getStr(row, "name");
            if (!name) continue;

            let ast = map.get(name);
            if (!ast) {
                const sma = getNum(row, "semi_major_axis");
                const ecc = getNum(row, "eccentricity");
                if (sma <= 0 || ecc <= 0 || ecc >= 1) continue;   // need valid orbit to cluster
                ast = {
                    name,
                    shortName:  getStr(row, "short_name") || name,
                    hazardous:  getStr(row, "potentially_hazardous").toLowerCase() === "true",
                    sma, ecc,
                    inc:        getNum(row, "inclination"),
                    orbitClass: getStr(row, "orbit_class_type"),
                    diameterM:  getNum(row, "diameter_max_m"),
                    hits: [], closestBody: "", closestProx: Infinity, hasApproachData: false,
                };
                map.set(name, ast);
            }

            // Actual-collision test for this approach (if close-approach fields present)
            const canon = BODY_ALIAS[getStr(row, "orbiting_body")];
            if (!canon) continue;
            // Accept whichever miss-distance / velocity variant is mapped.
            const missKm = getNum(row, "miss_distance_km")
                || getNum(row, "miss_distance_au")    * AU_KM
                || getNum(row, "miss_distance_lunar") * LD_KM;
            const vCa    = getNum(row, "velocity_km_s") || getNum(row, "velocity_km_h") / 3600;
            if (missKm <= 0 || vCa <= 0) continue;
            ast.hasApproachData = true;

            const body = BODIES[canon];
            const occ  = getNum(row, "orbit_uncertainty");
            const cap  = captureRadiusKm(body, vCa);
            const prox = (missKm - errorKm(missKm, occ, sigma)) / cap;   // ≤1 ⇒ impact
            if (prox <= 1 && ast.hits.indexOf(canon) === -1) ast.hits.push(canon);
            if (prox < ast.closestProx) { ast.closestProx = prox; ast.closestBody = canon; }
        }

        this.asteroids = Array.from(map.values());
    }

    // -----------------------------------------------------------------------
    private render(): void {
        const { M } = this;
        const plotW = this.width  - M.left - M.right;
        const plotH = this.height - M.top  - M.bottom;

        this.svg.selectAll("*").remove();
        this.svg.append("rect")
            .attr("width", this.width).attr("height", this.height)
            .attr("fill", "#050510");

        if (this.asteroids.length === 0) {
            const lines = this.rowCount === 0
                ? ["Map asteroid fields to plot clustering"]
                : [`Received ${this.rowCount} rows but none had valid orbital data.`,
                   "Clustering needs name, semi_major_axis, eccentricity & inclination",
                   "mapped (eccentricity must be 0–1). Set numeric fields to \"Don't summarize\"."];
            const t = this.svg.append("text")
                .attr("x", this.width / 2).attr("y", this.height / 2 - (lines.length - 1) * 9)
                .attr("text-anchor", "middle").attr("fill", "#8899bb")
                .attr("font-family", "sans-serif").attr("font-size", "13px");
            lines.forEach((ln, i) => t.append("tspan")
                .attr("x", this.width / 2).attr("dy", i === 0 ? 0 : 18)
                .attr("font-size", i === 0 ? "13px" : "11px")
                .attr("fill", i === 0 ? "#aab4cc" : "#8899bb")
                .text(ln));
            return;
        }

        const cfg           = this.formattingSettings.display;
        const k             = Math.max(2, Math.min(8, Math.round(cfg.numClusters.value)));
        const showEllipses  = cfg.showEllipses.value;
        const hazOnly       = cfg.showHazardousOnly.value;
        const sigma         = Math.max(0, Math.min(9, cfg.sigmaLevel.value));
        const showTrend     = cfg.showTrendLine.value;

        const pool = hazOnly ? this.asteroids.filter(a => a.hazardous) : this.asteroids;
        if (pool.length === 0) return;

        // Normalise features to [0,1] for clustering (sma, ecc, inc)
        const smaExt = d3.extent(pool, d => d.sma) as [number, number];
        const eccExt = d3.extent(pool, d => d.ecc) as [number, number];
        const incExt = d3.extent(pool, d => d.inc) as [number, number];

        const n01 = (v: number, [lo, hi]: [number, number]) =>
            hi > lo ? (v - lo) / (hi - lo) : 0;

        const points = pool.map(a => [n01(a.sma, smaExt), n01(a.ecc, eccExt), n01(a.inc, incExt)]);
        const { labels } = kMeans(points, k);
        const clusters  = computeClusters(pool, labels, k);
        const ciByIdx   = new Map(clusters.map(ci => [ci.idx, ci]));

        // Display axes: semi-major axis (x) vs eccentricity (y)
        const xScale = d3.scaleLinear()
            .domain([smaExt[0] * 0.95, smaExt[1] * 1.05])
            .range([0, plotW]);
        const yScale = d3.scaleLinear()
            .domain([Math.max(0, eccExt[0] * 0.9), Math.min(0.99, eccExt[1] * 1.1)])
            .range([plotH, 0]);

        const g = this.svg.append("g").attr("transform", `translate(${M.left},${M.top})`);

        // Subtle grid
        g.append("g")
            .attr("transform", `translate(0,${plotH})`)
            .call(d3.axisBottom(xScale).ticks(8).tickSize(-plotH) as any)
            .call(ag => { ag.select(".domain").remove(); ag.selectAll("line").attr("stroke", "#131830").attr("stroke-dasharray", "2,4"); ag.selectAll("text").remove(); });

        g.append("g")
            .call(d3.axisLeft(yScale).ticks(6).tickSize(-plotW) as any)
            .call(ag => { ag.select(".domain").remove(); ag.selectAll("line").attr("stroke", "#131830").attr("stroke-dasharray", "2,4"); ag.selectAll("text").remove(); });

        // Error ellipses (2σ spread of each cluster) + an on-plot family label
        for (let c = 0; c < k; c++) {
            const ci = ciByIdx.get(c);
            if (!ci) continue;
            const members = pool.filter((_, i) => labels[i] === c);
            const xs = members.map(a => xScale(a.sma));
            const ys = members.map(a => yScale(a.ecc));
            const el = members.length >= 3 ? clusterEllipse(xs, ys) : null;
            const col = ci.color;

            if (showEllipses && el) {
                g.append("ellipse")
                    .attr("cx", el.cx).attr("cy", el.cy)
                    .attr("rx", Math.max(4, el.rx)).attr("ry", Math.max(2, el.ry))
                    .attr("transform", `rotate(${el.angleDeg},${el.cx},${el.cy})`)
                    .attr("fill", col).attr("fill-opacity", 0.06)
                    .attr("stroke", col).attr("stroke-width", 1.4)
                    .attr("stroke-opacity", 0.55)
                    .attr("stroke-dasharray", "4,3");
            }

            // Label the cluster on the plot at its centroid (so it's readable
            // without cross-referencing the legend).
            const lxp = el ? el.cx : xScale(ci.meanA);
            const lyp = el ? el.cy - Math.max(2, el.ry) - 5 : yScale(ci.meanE);
            g.append("text")
                .attr("x", lxp).attr("y", lyp)
                .attr("text-anchor", "middle").attr("fill", col)
                .attr("font-family", "sans-serif").attr("font-size", "11px")
                .attr("font-weight", "bold")
                .attr("paint-order", "stroke").attr("stroke", "#050510").attr("stroke-width", 3)
                .text(ci.label);
        }

        // Dots — impactors (would actually hit a body within σ) get a bright red ring
        const self = this;
        const baseR = (d: AsteroidPoint) => d.hits.length > 0 ? 5 : d.hazardous ? 4.5 : 2.5;
        g.selectAll<SVGCircleElement, AsteroidPoint>("circle.pt")
            .data(pool)
            .enter()
            .append("circle").classed("pt", true)
            .attr("cx", d => xScale(d.sma))
            .attr("cy", d => yScale(d.ecc))
            .attr("r",  baseR)
            .attr("fill",         (_, i) => CLUSTER_COLORS[labels[i] % CLUSTER_COLORS.length])
            .attr("fill-opacity", 0.72)
            .attr("stroke",       (d, i) => d.hits.length > 0 ? "#ff2e2e" : CLUSTER_COLORS[labels[i] % CLUSTER_COLORS.length])
            .attr("stroke-width", d => d.hits.length > 0 ? 2.2 : d.hazardous ? 1.6 : 0.5)
            .attr("stroke-opacity", d => d.hits.length > 0 ? 1 : 0.9)
            .style("cursor", "pointer")
            .on("mouseover", function(event, d) {
                const idx = pool.indexOf(d);
                const ci  = ciByIdx.get(labels[idx]);
                const cls = ORBIT_CLASS[d.orbitClass];
                const impactLine = d.hits.length > 0
                    ? `<span style="color:#ff5555">⊙ WOULD HIT: ${d.hits.join(", ")} (within ${sigma}σ)</span>`
                    : d.hasApproachData
                        ? `Closest: ${d.closestBody || "—"} — ${isFinite(d.closestProx) ? d.closestProx.toFixed(1) + "× capture R" : "n/a"} (no hit)`
                        : `<span style="color:#778">No close-approach data mapped</span>`;
                self.showTip(
                    `<b>${d.name}</b><br>` +
                    `Group: <span style="color:${ci?.color}">${ci?.label ?? "—"}</span><br>` +
                    `Class: ${cls ? cls.name + " — " + cls.desc : d.orbitClass}<br>` +
                    `SMA: ${d.sma.toFixed(3)} AU &nbsp; Ecc: ${d.ecc.toFixed(4)} &nbsp; Inc: ${d.inc.toFixed(2)}°<br>` +
                    impactLine + "<br>" +
                    (d.hazardous ? `<span style="color:#ff6666">⚠ Potentially Hazardous</span>` : ""),
                    event.clientX, event.clientY
                );
                d3.select(this).attr("r", 8).attr("fill-opacity", 1);
            })
            .on("mouseout", function(_, d) {
                d3.select(this).attr("r", baseR(d)).attr("fill-opacity", 0.72);
                self.hideTip();
            });

        // Trend line — OLS fit of semi-major axis vs eccentricity across all points
        if (showTrend) {
            const fit = fitLinePx(pool.map(a => ({ x: xScale(a.sma), y: yScale(a.ecc) })));
            if (fit) {
                let x0 = 0, y0 = fit.b, x1 = plotW, y1 = fit.m * plotW + fit.b;
                if (fit.m !== 0) {
                    if (y0 < 0)      { y0 = 0;     x0 = (0 - fit.b) / fit.m; }
                    else if (y0 > plotH) { y0 = plotH; x0 = (plotH - fit.b) / fit.m; }
                    if (y1 < 0)      { y1 = 0;     x1 = (0 - fit.b) / fit.m; }
                    else if (y1 > plotH) { y1 = plotH; x1 = (plotH - fit.b) / fit.m; }
                }
                g.append("line")
                    .attr("x1", x0).attr("y1", y0).attr("x2", x1).attr("y2", y1)
                    .attr("stroke", "#e0e6ff").attr("stroke-width", 1.6)
                    .attr("stroke-opacity", 0.7).attr("stroke-dasharray", "7,5");
                g.append("text")
                    .attr("x", x1 - 4).attr("y", y1 - 6)
                    .attr("text-anchor", "end").attr("fill", "#e0e6ff")
                    .attr("fill-opacity", 0.8).attr("font-family", "sans-serif").attr("font-size", "10px")
                    .text(`trend  r²=${fit.r2.toFixed(2)}`);
            }
        }

        // Axes
        const ac = "#3a4a6a", tc = "#8899bb";
        g.append("g").attr("transform", `translate(0,${plotH})`)
            .call(d3.axisBottom(xScale).ticks(8))
            .call(ag => { ag.select(".domain").attr("stroke", ac); ag.selectAll("line").attr("stroke", ac); ag.selectAll("text").attr("fill", tc).attr("font-size", "10px"); });

        g.append("g")
            .call(d3.axisLeft(yScale).ticks(6))
            .call(ag => { ag.select(".domain").attr("stroke", ac); ag.selectAll("line").attr("stroke", ac); ag.selectAll("text").attr("fill", tc).attr("font-size", "10px"); });

        // Axis labels
        g.append("text").attr("x", plotW / 2).attr("y", plotH + 44)
            .attr("text-anchor", "middle").attr("fill", "#9fb0d8")
            .attr("font-family", "sans-serif").attr("font-size", "12px")
            .text("Semi-Major Axis (AU)");

        g.append("text")
            .attr("transform", `rotate(-90)`)
            .attr("x", -plotH / 2).attr("y", -50)
            .attr("text-anchor", "middle").attr("fill", "#9fb0d8")
            .attr("font-family", "sans-serif").attr("font-size", "12px")
            .text("Eccentricity");

        // Chart title + explanatory subtitle
        this.svg.append("text").attr("x", M.left + plotW / 2).attr("y", 22)
            .attr("text-anchor", "middle").attr("fill", "#dde8ff")
            .attr("font-family", "sans-serif").attr("font-size", "14px").attr("font-weight", "bold")
            .text(`Asteroid Orbital Families  ·  ${k} groups  ·  n=${pool.length}`);
        this.svg.append("text").attr("x", M.left + plotW / 2).attr("y", 39)
            .attr("text-anchor", "middle").attr("fill", "#8899bb")
            .attr("font-family", "sans-serif").attr("font-size", "10px")
            .text(`Groups = similar orbits.  Red ring = would actually hit a body within ${sigma}σ (same test as Impact Table).`);

        // Legend — one descriptive block per cluster (family, mean orbit, planets crossed)
        const lx = M.left + plotW + 14;
        const lg = this.svg.append("g").attr("transform", `translate(${lx},${M.top})`);
        lg.append("text").attr("x", 0).attr("y", 2)
            .attr("fill", "#dde8ff").attr("font-family", "sans-serif")
            .attr("font-size", "11px").attr("font-weight", "bold").text("Orbital families");

        const ordered = [...clusters].sort((a, b) => b.count - a.count);
        const rowH = Math.min(46, Math.max(34, (plotH - 70) / Math.max(1, ordered.length)));
        ordered.forEach((ci, row) => {
            const y = 16 + row * rowH;
            lg.append("circle").attr("cx", 8).attr("cy", y + 4).attr("r", 6)
                .attr("fill", ci.color).attr("fill-opacity", 0.8);
            if (showEllipses) {
                lg.append("ellipse").attr("cx", 8).attr("cy", y + 4)
                    .attr("rx", 11).attr("ry", 5.5)
                    .attr("fill", "none").attr("stroke", ci.color)
                    .attr("stroke-width", 1.2).attr("stroke-opacity", 0.5)
                    .attr("stroke-dasharray", "3,2");
            }
            // Family name (+ hazardous count if any)
            lg.append("text").attr("x", 24).attr("y", y + 1)
                .attr("fill", ci.color).attr("font-family", "sans-serif")
                .attr("font-size", "11px").attr("font-weight", "bold")
                .text(`${ci.label}  (${ci.count})`);
            if (ci.hazCount > 0) {
                lg.append("text").attr("x", 24).attr("y", y + 13)
                    .attr("fill", "#ff6666").attr("font-family", "sans-serif").attr("font-size", "9px")
                    .text(`⚠ ${ci.hazCount} hazardous`);
            }
            // Mean orbit
            lg.append("text").attr("x", 24).attr("y", y + (ci.hazCount > 0 ? 24 : 13))
                .attr("fill", tc).attr("font-family", "monospace").attr("font-size", "9px")
                .text(`a≈${ci.meanA.toFixed(2)}  e≈${ci.meanE.toFixed(2)}  i≈${ci.meanI.toFixed(0)}°`);
            // Actual-collision result for the group (matches the Impact Table)
            const hy = y + (ci.hazCount > 0 ? 35 : 24);
            if (!ci.hasApproachData) {
                lg.append("text").attr("x", 24).attr("y", hy)
                    .attr("fill", "#667").attr("font-family", "sans-serif").attr("font-size", "9px")
                    .text("no approach data");
            } else if (ci.hitBodies.length > 0) {
                lg.append("text").attr("x", 24).attr("y", hy)
                    .attr("fill", "#ff6a6a").attr("font-family", "sans-serif").attr("font-size", "9px")
                    .text("⊙ hits: " + ci.hitBodies.map(h => `${h.body}×${h.n}`).join(", "));
            } else {
                lg.append("text").attr("x", 24).attr("y", hy)
                    .attr("fill", "#7fa0d8").attr("font-family", "sans-serif").attr("font-size", "9px")
                    .text(`0 hits · closest: ${ci.closestBody || "—"}`);
            }
        });

        // Footer notes
        const sepY = 22 + ordered.length * rowH;
        lg.append("line").attr("x1", 0).attr("y1", sepY).attr("x2", 188).attr("y2", sepY)
            .attr("stroke", "#334466").attr("stroke-width", 1);
        lg.append("circle").attr("cx", 5).attr("cy", sepY + 11).attr("r", 4)
            .attr("fill", "none").attr("stroke", "#ff2e2e").attr("stroke-width", 1.8);
        lg.append("text").attr("x", 14).attr("y", sepY + 14)
            .attr("fill", "#ff8a8a").attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("= would hit a body (within σ)");
        lg.append("text").attr("x", 0).attr("y", sepY + 27)
            .attr("fill", "#556688").attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("Impact = miss − error ≤ capture R,");
        lg.append("text").attr("x", 0).attr("y", sepY + 38)
            .attr("fill", "#556688").attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("identical to the Impact Table.");
        lg.append("text").attr("x", 0).attr("y", sepY + 49)
            .attr("fill", "#556688").attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("Set σ to match that visual.");
    }

    // -----------------------------------------------------------------------
    private showTip(html: string, x: number, y: number): void {
        if (!this.tooltip) {
            this.tooltip = d3.select(document.body).append("div")
                .style("position", "fixed").style("background", "rgba(5,5,20,0.93)")
                .style("color", "#eee").style("border", "1px solid #334")
                .style("border-radius", "6px").style("padding", "8px 12px")
                .style("font-family", "monospace").style("font-size", "12px")
                .style("pointer-events", "none").style("line-height", "1.6")
                .style("max-width", "260px").style("z-index", "9999")
                .style("display", "none");
        }
        this.tooltip.style("display", "block")
            .style("left", (x + 14) + "px").style("top", (y - 10) + "px").html(html);
    }

    private hideTip(): void { this.tooltip?.style("display", "none"); }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    public destroy(): void { this.tooltip?.remove(); }
}
