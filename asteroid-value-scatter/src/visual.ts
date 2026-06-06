"use strict";

import powerbi from "powerbi-visuals-api";
import * as d3 from "d3";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualSettings } from "./settings";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions       = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual                   = powerbi.extensibility.visual.IVisual;
import DataView                  = powerbi.DataView;

// "Value score" = diameter_max_m * velocity_km_s / miss_distance_km
// Represents a rough proxy for scientific/economic potential:
//   large body + fast-moving + close approach = high-value target.

// Ordinary-least-squares fit in plot (pixel) space. Fitting on the already-scaled
// coordinates makes the trend line straight on screen regardless of whether the
// axes are linear or log. Returns slope/intercept (py = m·px + b) and R².
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

interface AsteroidValue {
    name:          string;
    shortName:     string;
    hazardous:     boolean;
    diameterM:     number;      // diameter_max_m
    velocityKmS:   number;      // velocity at closest Earth approach
    missDistAU:    number;      // miss distance at closest Earth approach
    missDistKm:    number;
    missDistLunar: number;
    valueScore:    number;      // diameter * velocity / missDistKm
    orbitClass:    string;
    approachDate:  string;
}

export class Visual implements IVisual {
    private host:                     powerbi.extensibility.visual.IVisualHost;
    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings:        VisualSettings;
    private container:                 d3.Selection<HTMLDivElement, unknown, null, undefined>;
    private svg:                       d3.Selection<SVGSVGElement, unknown, null, undefined>;
    private tooltip:                   d3.Selection<HTMLDivElement, unknown, null, undefined> | null = null;

    private width  = 800;
    private height = 600;
    private readonly M = { top: 44, right: 40, bottom: 70, left: 80 };

    private asteroids: AsteroidValue[] = [];

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
    // Deduplicate by asteroid name — keep the closest Earth approach per asteroid.
    private parseData(dataView: DataView): void {
        this.asteroids = [];
        if (!dataView.table) return;

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

        // Accumulate best (closest Earth) approach per asteroid
        const best = new Map<string, AsteroidValue>();

        for (const row of dataView.table.rows) {
            const name    = getStr(row, "name");
            const body    = getStr(row, "orbiting_body");
            if (!name) continue;

            const diamM    = getNum(row, "diameter_max_m");
            const vel      = getNum(row, "velocity_km_s");
            const missAU   = getNum(row, "miss_distance_au");
            const missKm   = getNum(row, "miss_distance_km");
            const missLunar= getNum(row, "miss_distance_lunar");
            if (missAU <= 0 || vel <= 0 || diamM <= 0) continue;

            // Only use Earth approaches for the scatter (most relevant metric)
            if (body !== "Earth" && body !== "") continue;

            const score = (diamM * vel) / (missKm || 1);
            const prev  = best.get(name);
            if (!prev || missAU < prev.missDistAU) {
                best.set(name, {
                    name,
                    shortName:     getStr(row, "short_name") || name,
                    hazardous:     getStr(row, "potentially_hazardous").toLowerCase() === "true",
                    diameterM:     diamM,
                    velocityKmS:   vel,
                    missDistAU:    missAU,
                    missDistKm:    missKm,
                    missDistLunar: missLunar,
                    valueScore:    score,
                    orbitClass:    getStr(row, "orbit_class_type"),
                    approachDate:  getStr(row, "close_approach_date"),
                });
            }
        }

        this.asteroids = Array.from(best.values());
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
            this.svg.append("text")
                .attr("x", this.width / 2).attr("y", this.height / 2)
                .attr("text-anchor", "middle").attr("fill", "#8899bb")
                .attr("font-family", "sans-serif").attr("font-size", "13px")
                .text("Map asteroid fields to plot value scatter");
            return;
        }

        const cfg        = this.formattingSettings.display;
        const hazOnly    = cfg.showHazardousOnly.value;
        const showZone   = cfg.highlightQuadrant.value;
        const maxMiss    = cfg.maxMissDistAU.value;
        const maxPtSize  = Math.max(6, cfg.maxPointSize.value);
        const sizeExp    = Math.max(0.5, cfg.sizeContrast.value);
        const showCatch  = cfg.showCatchable.value;
        const logVelX    = cfg.logVelocityAxis.value;
        const showTrend  = cfg.showTrendLine.value;
        const catchKmh   = Math.max(0, cfg.catchableKmh.value);
        const catchKmS   = catchKmh / 3600;                       // speed limit in km/s
        const isCatchable = (d: AsteroidValue) => d.velocityKmS < catchKmS;
        const catchColor = "#37e0a0";

        let pool = hazOnly ? this.asteroids.filter(a => a.hazardous) : this.asteroids;
        pool = pool.filter(a => a.missDistAU <= maxMiss);
        if (pool.length === 0) return;

        // Axes
        // X: velocity_km_s  (linear)
        // Y: miss_distance_au (log) — closer approaches sit lower
        const velExt  = d3.extent(pool, d => d.velocityKmS) as [number, number];
        const diamExt = d3.extent(pool, d => d.diameterM)   as [number, number];
        const missExt = d3.extent(pool, d => d.missDistAU)  as [number, number];

        const xScale = logVelX
            ? d3.scaleLog().domain([Math.max(0.1, velExt[0] * 0.85), velExt[1] * 1.1]).range([0, plotW]).clamp(true)
            : d3.scaleLinear().domain([Math.max(0, velExt[0] - 1), velExt[1] * 1.05]).range([0, plotW]);
        const yScale = d3.scaleLog()
            .domain([Math.max(1e-5, missExt[0] * 0.8), missExt[1] * 1.2])
            .range([plotH, 0])
            .clamp(true);

        // Dot size: diameter (bigger rock = bigger dot).
        //   radius = 2 + norm^contrast · (maxSize − 2),  norm∈[0,1], log-spaced so the
        //   1000× diameter range reads well. maxPtSize sets spread; sizeExp sets contrast.
        const logD = (d: number) => Math.log10(Math.max(1, d));
        const dLo = logD(diamExt[0]), dHi = logD(diamExt[1]);
        const dSpan = (dHi - dLo) || 1;
        const rScale = (diam: number): number => {
            const norm = (logD(diam) - dLo) / dSpan;               // 0 = smallest, 1 = largest
            return 2 + Math.pow(Math.max(0, Math.min(1, norm)), sizeExp) * (maxPtSize - 2);
        };

        // Color: value score → orange-to-blue scale (high score = orange)
        const scoreExt = d3.extent(pool, d => d.valueScore) as [number, number];
        const colorScale = d3.scaleSequential(d3.interpolateYlOrRd)
            .domain([scoreExt[0], scoreExt[1]]);

        const g = this.svg.append("g").attr("transform", `translate(${M.left},${M.top})`);

        // Grid
        g.append("g").attr("transform", `translate(0,${plotH})`)
            .call(d3.axisBottom(xScale).ticks(8).tickSize(-plotH) as any)
            .call(ag => { ag.select(".domain").remove(); ag.selectAll("line").attr("stroke", "#131830").attr("stroke-dasharray", "2,4"); ag.selectAll("text").remove(); });
        g.append("g")
            .call(d3.axisLeft(yScale).ticks(6, "~g").tickSize(-plotW) as any)
            .call(ag => { ag.select(".domain").remove(); ag.selectAll("line").attr("stroke", "#131830").attr("stroke-dasharray", "2,4"); ag.selectAll("text").remove(); });

        // High-value zone highlight (bottom-right: fast + close = high value score)
        if (showZone) {
            const velMid  = d3.median(pool, d => d.velocityKmS) ?? velExt[1] / 2;
            const missMid = d3.median(pool, d => d.missDistAU)  ?? missExt[1] / 2;
            const zx = xScale(velMid);
            const zy = yScale(missMid);            // closer (smaller miss) is lower on the plot
            g.append("rect")
                .attr("x", zx).attr("y", zy)
                .attr("width", plotW - zx).attr("height", plotH - zy)
                .attr("fill", "#ffa50010").attr("stroke", "#ffa500")
                .attr("stroke-width", 1).attr("stroke-opacity", 0.35)
                .attr("stroke-dasharray", "6,4");
            g.append("text")
                .attr("x", zx + (plotW - zx) / 2).attr("y", plotH - 8)
                .attr("text-anchor", "middle").attr("fill", "#ffa500")
                .attr("fill-opacity", 0.6).attr("font-family", "sans-serif")
                .attr("font-size", "10px").text("HIGH VALUE ZONE");
        }

        // "Catchable" threshold — slow enough to intercept. Shade the zone left of
        // the speed limit and draw the boundary line (only if it falls in range).
        const catchN = pool.filter(isCatchable).length;
        if (showCatch && catchKmS > xScale.domain()[0] && catchKmS < xScale.domain()[1]) {
            const cx = xScale(catchKmS);
            g.append("rect")
                .attr("x", 0).attr("y", 0).attr("width", cx).attr("height", plotH)
                .attr("fill", catchColor).attr("fill-opacity", 0.05);
            g.append("line")
                .attr("x1", cx).attr("y1", 0).attr("x2", cx).attr("y2", plotH)
                .attr("stroke", catchColor).attr("stroke-width", 1.4)
                .attr("stroke-opacity", 0.7).attr("stroke-dasharray", "5,4");
            g.append("text")
                .attr("x", cx - 6).attr("y", plotH - 8)
                .attr("text-anchor", "end").attr("fill", catchColor)
                .attr("fill-opacity", 0.85).attr("font-family", "sans-serif")
                .attr("font-size", "10px").attr("font-weight", "bold")
                .text(`◄ CATCHABLE (< ${catchKmh.toLocaleString()} km/h)`);
        }

        // Dots — catchable asteroids get a green ring (fill still encodes hazard/value)
        const self = this;
        const strokeOf = (d: AsteroidValue) =>
            (showCatch && isCatchable(d)) ? catchColor : d.hazardous ? "#ff9999" : "#ffffff";
        const strokeWOf = (d: AsteroidValue) =>
            (showCatch && isCatchable(d)) ? 2 : d.hazardous ? 1.4 : 0.4;
        g.selectAll<SVGCircleElement, AsteroidValue>("circle.pt")
            .data(pool)
            .enter()
            .append("circle").classed("pt", true)
            .attr("cx", d => xScale(d.velocityKmS))
            .attr("cy", d => yScale(d.missDistAU))
            .attr("r",  d => rScale(d.diameterM))
            .attr("fill", d => d.hazardous ? "#ff4444" : colorScale(d.valueScore))
            .attr("fill-opacity", 0.75)
            .attr("stroke", strokeOf)
            .attr("stroke-width", strokeWOf)
            .attr("stroke-opacity", 0.9)
            .style("cursor", "pointer")
            .on("mouseover", function(event, d) {
                const catchLine = isCatchable(d)
                    ? `<span style="color:${catchColor}">✓ Catchable (slow enough to intercept)</span>`
                    : `<span style="color:#889">✗ Too fast to catch</span>`;
                self.showTip(
                    `<b>${d.name}</b><br>` +
                    (d.hazardous ? `<span style="color:#ff6666">⚠ Potentially Hazardous</span><br>` : "") +
                    `Diameter: ${(d.diameterM / 1000).toFixed(2)} km<br>` +
                    `Velocity: ${d.velocityKmS.toFixed(2)} km/s  (${(d.velocityKmS * 3600).toLocaleString(undefined, {maximumFractionDigits: 0})} km/h)<br>` +
                    catchLine + "<br>" +
                    `Miss dist: ${d.missDistAU.toFixed(4)} AU  (${d.missDistLunar.toFixed(1)} LD)<br>` +
                    `Value score: ${d.valueScore.toFixed(1)}<br>` +
                    `Class: ${d.orbitClass}<br>` +
                    `Approach: ${d.approachDate}`,
                    event.clientX, event.clientY
                );
                d3.select(this).attr("r", rScale(d.diameterM) + 4).attr("fill-opacity", 1);
            })
            .on("mouseout", function(_, d) {
                d3.select(this).attr("r", rScale(d.diameterM)).attr("fill-opacity", 0.75);
                self.hideTip();
            });

        // Trend line — OLS fit of the plotted cloud (velocity vs miss distance)
        if (showTrend) {
            const fit = fitLinePx(pool.map(d => ({ x: xScale(d.velocityKmS), y: yScale(d.missDistAU) })));
            if (fit) {
                // Endpoints across the plot width, clamped into the plot rect
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
                    .attr("stroke-opacity", 0.75).attr("stroke-dasharray", "7,5");
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
            .call(d3.axisBottom(xScale).ticks(6, "~g"))
            .call(ag => { ag.select(".domain").attr("stroke", ac); ag.selectAll("line").attr("stroke", ac); ag.selectAll("text").attr("fill", tc).attr("font-size", "10px"); });

        g.append("g")
            .call(d3.axisLeft(yScale).ticks(6, "~g"))
            .call(ag => { ag.select(".domain").attr("stroke", ac); ag.selectAll("line").attr("stroke", ac); ag.selectAll("text").attr("fill", tc).attr("font-size", "10px"); });

        // Axis labels
        g.append("text").attr("x", plotW / 2).attr("y", plotH + 46)
            .attr("text-anchor", "middle").attr("fill", "#9fb0d8")
            .attr("font-family", "sans-serif").attr("font-size", "12px")
            .text("Close-approach velocity (km/s" + (logVelX ? ", log" : "") + ")");

        g.append("text").attr("transform", "rotate(-90)")
            .attr("x", -plotH / 2).attr("y", -60)
            .attr("text-anchor", "middle").attr("fill", "#9fb0d8")
            .attr("font-family", "sans-serif").attr("font-size", "12px")
            .text("Closest miss distance (AU, log) — lower = closer");

        // Chart title
        this.svg.append("text").attr("x", M.left + plotW / 2).attr("y", 26)
            .attr("text-anchor", "middle").attr("fill", "#dde8ff")
            .attr("font-family", "sans-serif").attr("font-size", "14px").attr("font-weight", "bold")
            .text(`Asteroid Value Scatter  ·  n=${pool.length}` +
                  (hazOnly ? "  ·  hazardous only" : "") +
                  (showCatch ? `  ·  ${catchN} catchable` : ""));

        // Legend (bottom-right)
        const legX = M.left + plotW - 190;
        const legY = M.top + plotH - 6;
        const legG = this.svg.append("g").attr("transform", `translate(${legX},${legY})`);

        // Dot size legend
        legG.append("text").attr("x", 0).attr("y", -10)
            .attr("fill", "#556688").attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("Dot size = diameter (bigger rock = bigger dot)");

        // Color legend strip (value score)
        const gradId = "valueGrad";
        const defs = this.svg.append("defs");
        const grad = defs.append("linearGradient").attr("id", gradId)
            .attr("x1", "0%").attr("x2", "100%");
        for (let i = 0; i <= 10; i++) {
            grad.append("stop")
                .attr("offset", `${i * 10}%`)
                .attr("stop-color", d3.interpolateYlOrRd(i / 10));
        }

        legG.append("rect").attr("x", 0).attr("y", 2).attr("width", 120).attr("height", 8)
            .attr("fill", `url(#${gradId})`).attr("rx", 2);
        legG.append("text").attr("x", 0).attr("y", 22)
            .attr("fill", tc).attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("Low value");
        legG.append("text").attr("x", 120).attr("y", 22)
            .attr("text-anchor", "end").attr("fill", tc).attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("High value");
        legG.append("text").attr("x", 60).attr("y", 33)
            .attr("text-anchor", "middle").attr("fill", "#556688").attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("Color = diam × vel / dist");

        // Hazardous marker
        legG.append("circle").attr("cx", 140).attr("cy", 8).attr("r", 5)
            .attr("fill", "#ff4444").attr("stroke", "#ff9999").attr("stroke-width", 1.2);
        legG.append("text").attr("x", 148).attr("y", 12)
            .attr("fill", tc).attr("font-family", "sans-serif").attr("font-size", "9px")
            .text("Hazardous");

        // Catchable marker
        if (showCatch) {
            legG.append("circle").attr("cx", 140).attr("cy", 26).attr("r", 5)
                .attr("fill", "none").attr("stroke", catchColor).attr("stroke-width", 2);
            legG.append("text").attr("x", 148).attr("y", 30)
                .attr("fill", tc).attr("font-family", "sans-serif").attr("font-size", "9px")
                .text(`Catchable (< ${catchKmS.toFixed(0)} km/s)`);
        }
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
                .style("max-width", "280px").style("z-index", "9999")
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
