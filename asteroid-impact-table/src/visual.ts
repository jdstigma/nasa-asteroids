"use strict";

import powerbi from "powerbi-visuals-api";
import * as d3 from "d3";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualSettings } from "./settings";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions       = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual                   = powerbi.extensibility.visual.IVisual;
import DataView                  = powerbi.DataView;

// ---------------------------------------------------------------------------
// Physical body data for the impact test.
//   radiusKm = physical mean radius
//   vEsc     = surface escape velocity (km/s), used for gravitational focusing
// The dataset's `orbiting_body` strings map to these via BODY_ALIAS.
// ---------------------------------------------------------------------------
interface BodyDef { name: string; emoji: string; radiusKm: number; vEsc: number; }

const BODIES: Record<string, BodyDef> = {
    Mercury: { name: "Mercury", emoji: "☿",  radiusKm: 2439.7, vEsc: 4.25  },
    Venus:   { name: "Venus",   emoji: "♀",  radiusKm: 6051.8, vEsc: 10.36 },
    Earth:   { name: "Earth",   emoji: "🌍", radiusKm: 6371.0, vEsc: 11.19 },
    Moon:    { name: "Moon",    emoji: "🌙", radiusKm: 1737.4, vEsc: 2.38  },
    Mars:    { name: "Mars",    emoji: "♂",  radiusKm: 3389.5, vEsc: 5.03  },
    Jupiter: { name: "Jupiter", emoji: "♃",  radiusKm: 69911,  vEsc: 59.5  },
    Saturn:  { name: "Saturn",  emoji: "♄",  radiusKm: 58232,  vEsc: 35.5  },
    Uranus:  { name: "Uranus",  emoji: "♅",  radiusKm: 25362,  vEsc: 21.3  },
    Neptune: { name: "Neptune", emoji: "♆",  radiusKm: 24622,  vEsc: 23.5  },
};

// CNEOS abbreviations seen in orbiting_body → canonical name
const BODY_ALIAS: Record<string, string> = {
    "Earth": "Earth", "Moon": "Moon", "Mars": "Mars",
    "Merc": "Mercury", "Venus": "Venus", "Juptr": "Jupiter",
};

const AU_KM = 149597870.7;
const LD_KM = 384400;        // 1 lunar distance (mean Earth–Moon distance) in km

// ---------------------------------------------------------------------------
// One close-approach encounter that resolves to a possible impact.
// Kept per (asteroid, body) pair — the closest-margin encounter.
// ---------------------------------------------------------------------------
interface ImpactRow {
    name:         string;
    shortName:    string;
    hazardous:    boolean;
    diameterM:    number;
    body:         string;       // canonical body name
    bodyEmoji:    string;
    date:         string;       // close_approach_date of the worst encounter
    occ:          number;       // orbit_uncertainty (0–9)
    vCa:          number;       // velocity at closest approach (km/s)
    missKm:       number;       // propagated miss distance (km) — planet position baked in
    missAU:       number;
    missLunar:    number;       // miss distance in lunar distances (1 LD = 384,400 km)
    moidAU:       number;       // min_orbit_intersection (orbit-to-orbit min separation)
    captureKm:    number;       // gravitational capture radius
    errorKm:      number;       // positional uncertainty at chosen σ
    marginKm:     number;       // missKm - errorKm - captureKm  (≤0 ⇒ impact possible)
    proximity:    number;       // (missKm - errorKm) / captureKm  (≤1 ⇒ impact possible)
    verdict:      "DIRECT" | "WITHIN-ERROR" | "NEAR-MISS";
}

export class Visual implements IVisual {
    private host:                     powerbi.extensibility.visual.IVisualHost;
    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings:        VisualSettings;
    private container:                 d3.Selection<HTMLDivElement, unknown, null, undefined>;

    private sortCol  = "marginKm";
    private sortAsc  = true;          // smallest margin (deepest impact) first
    private rows: ImpactRow[] = [];
    // What the last dataView contained — drives the diagnostic empty state.
    private diag = { rows: 0, body: false, miss: false, vel: false, bodyMatched: 0 };

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.formattingSettingsService = new FormattingSettingsService();
        this.formattingSettings        = new VisualSettings();

        this.container = d3.select(options.element)
            .append("div")
            .classed("impact-container", true)
            .style("position", "relative")
            .style("width", "100%")
            .style("height", "100%")
            .style("background", "#050510")
            .style("overflow", "hidden")
            .style("font-family", "monospace")
            .style("color", "#cdd5ee");
    }

    // -----------------------------------------------------------------------
    public update(options: VisualUpdateOptions): void {
        if (options.dataViews?.[0]) {
            this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(
                VisualSettings, options.dataViews[0]);
            this.parseData(options.dataViews[0]);
        }
        this.renderTable();
    }

    // -----------------------------------------------------------------------
    // Orbit-uncertainty → fractional positional error on the miss distance.
    // OCC is JPL's orbit condition code (0 = pristine, 9 = barely constrained).
    // We treat the 1σ along-track positional error as a fraction of the miss
    // distance that grows with OCC, then scale by the user's σ confidence.
    //   frac1σ = BASE * (OCC + 1)
    // BASE = 2% gives OCC0→2%, OCC1→4%, OCC2→6% per σ — tune via σ in the pane.
    private errorKm(missKm: number, occ: number, sigma: number): number {
        const BASE = 0.02;
        return missKm * BASE * (occ + 1) * sigma;
    }

    // Gravitational capture (impact cross-section) radius.
    // An object arriving with hyperbolic excess speed v_∞ strikes a body of
    // radius R if its impact parameter b < R·√(1 + (v_esc/v_∞)²), where v_esc is
    // the body's SURFACE escape velocity. The close-approach speed reported by
    // CNEOS is measured tens of thousands of km out, so it is ≈ v_∞ here.
    // This factor is always finite and ≥ 1 (gravity only enlarges the target).
    private captureRadiusKm(body: BodyDef, vCa: number, applyFocus: boolean): number {
        if (!applyFocus || vCa <= 0) return body.radiusKm;
        return body.radiusKm * Math.sqrt(1 + (body.vEsc / vCa) ** 2);
    }

    // -----------------------------------------------------------------------
    private parseData(dataView: DataView): void {
        this.rows = [];
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

        // Accept whichever miss-distance / velocity variant the user mapped and
        // convert to km / km·s⁻¹ — so the visual doesn't hard-fail on the _au or
        // _lunar column, or on velocity in km/h.
        const missDistKm = (row: powerbi.DataViewTableRow): number =>
            getNum(row, "miss_distance_km")
            || getNum(row, "miss_distance_au")    * AU_KM
            || getNum(row, "miss_distance_lunar") * LD_KM;
        const velKmS = (row: powerbi.DataViewTableRow): number =>
            getNum(row, "velocity_km_s") || getNum(row, "velocity_km_h") / 3600;

        // Diagnostics for the empty state
        this.diag = {
            rows: dataView.table.rows.length,
            body: "orbiting_body" in idx,
            miss: ["miss_distance_km", "miss_distance_au", "miss_distance_lunar"].some(c => c in idx),
            vel:  ["velocity_km_s", "velocity_km_h"].some(c => c in idx),
            bodyMatched: 0,
        };

        const cfg        = this.formattingSettings.display;
        const sigma      = Math.max(0, Math.min(9, cfg.sigmaLevel.value));
        const applyFocus = cfg.gravFocus.value;
        const earthOnly  = cfg.earthOnly.value;

        // Keep the closest (smallest-proximity) encounter per (asteroid, body) pair.
        const best = new Map<string, ImpactRow>();

        for (const row of dataView.table.rows) {
            const name = getStr(row, "name");
            if (!name) continue;

            const rawBody = getStr(row, "orbiting_body");
            const canon   = BODY_ALIAS[rawBody];
            if (!canon) continue;                       // unknown / blank body
            this.diag.bodyMatched++;
            if (earthOnly && canon !== "Earth") continue;

            const body  = BODIES[canon];
            const missKm = missDistKm(row);
            const missAU = getNum(row, "miss_distance_au") || (missKm / AU_KM);
            const vCa    = velKmS(row);
            if (missKm <= 0 || vCa <= 0) continue;

            const occ       = getNum(row, "orbit_uncertainty");
            const captureKm = this.captureRadiusKm(body, vCa, applyFocus);
            const errorKm   = this.errorKm(missKm, occ, sigma);
            const marginKm  = missKm - errorKm - captureKm;
            const proximity = (missKm - errorKm) / captureKm;   // ≤1 ⇒ impact possible

            const verdict: ImpactRow["verdict"] =
                missKm <= captureKm           ? "DIRECT"
                : (missKm - errorKm) <= captureKm ? "WITHIN-ERROR"
                : "NEAR-MISS";

            const key  = name + "|" + canon;
            const prev = best.get(key);
            if (prev && prev.proximity <= proximity) continue;   // keep closest call

            best.set(key, {
                name,
                shortName:  getStr(row, "short_name") || name,
                hazardous:  getStr(row, "potentially_hazardous").toLowerCase() === "true",
                diameterM:  getNum(row, "diameter_max_m"),
                body:       canon,
                bodyEmoji:  body.emoji,
                date:       getStr(row, "close_approach_date"),
                occ,
                vCa,
                missKm,
                missAU,
                missLunar:  getNum(row, "miss_distance_lunar") || (missKm / LD_KM),
                moidAU:     getNum(row, "min_orbit_intersection"),
                captureKm,
                errorKm,
                marginKm,
                proximity,
                verdict,
            });
        }

        this.rows = Array.from(best.values());
    }

    // -----------------------------------------------------------------------
    private renderTable(): void {
        this.container.selectAll("*").remove();

        const cfg         = this.formattingSettings.display;
        const sigma       = Math.max(0, Math.min(9, cfg.sigmaLevel.value));
        const hazFirst    = cfg.hazardousFirst.value;
        const impactsOnly = cfg.impactsOnly.value;
        const MAX_ROWS    = 400;

        // Header
        const header = this.container.append("div")
            .style("padding", "8px 14px 6px")
            .style("border-bottom", "1px solid #1e2a4a")
            .style("background", "#060812");

        header.append("span")
            .style("font-size", "13px").style("font-weight", "bold").style("color", "#dde8ff")
            .text("Predicted Planetary Impacts");

        const impacts     = this.rows.filter(r => r.verdict !== "NEAR-MISS");
        const directCount = this.rows.filter(r => r.verdict === "DIRECT").length;

        // Choose the working set: true impacts when requested, with a graceful
        // fallback to the closest approaches so the table is never blank.
        let pool: ImpactRow[];
        let fellBack = false;
        if (impactsOnly) {
            if (impacts.length > 0) {
                pool = impacts;
            } else {
                pool = [...this.rows].sort((a, b) => a.proximity - b.proximity).slice(0, 25);
                fellBack = true;
            }
        } else {
            pool = this.rows;
        }

        header.append("span")
            .style("font-size", "10px").style("color", "#667799").style("margin-left", "12px")
            .html(fellBack
                ? `<span style="color:#ffb74d">No impacts within ${sigma}σ — showing the 25 closest approaches (all clear their target's capture radius)</span>`
                : `${impacts.length} possible impact(s) within ${sigma}σ` +
                  (directCount ? `  ·  ${directCount} nominal direct hit(s)` : "") +
                  `  ·  ${this.rows.length} encounters evaluated`);

        if (this.rows.length === 0) {
            const yes = "<span style='color:#5fd17a'>✓ detected</span>";
            const no  = "<span style='color:#ff6b6b'>✗ not mapped</span>";
            const d   = this.diag;
            const bodyNote = d.body && d.bodyMatched === 0
                ? "<span style='color:#ffb74d'>✓ mapped, but no values matched Earth/Moon/Mars/Merc/Venus/Juptr</span>"
                : (d.body ? yes : no);
            this.container.append("div")
                .style("padding", "30px 40px").style("text-align", "center")
                .style("color", "#8aa").style("font-size", "12px").style("line-height", "1.9")
                .html(
                    `<div style="font-size:13px;color:#aab4cc;margin-bottom:10px">` +
                    `No usable close approaches in the ${d.rows} mapped row(s).</div>` +
                    `<div style="text-align:left;display:inline-block;font-family:monospace">` +
                    `orbiting_body &nbsp; ${bodyNote}<br>` +
                    `miss_distance (km / au / lunar) &nbsp; ${d.miss ? yes : no}<br>` +
                    `velocity (km_s / km_h) &nbsp; ${d.vel ? yes : no}</div>` +
                    `<div style="margin-top:10px;color:#667">Map any missing field and set numerics to “Don't summarize”.</div>`
                );
            return;
        }

        // Sort
        let sorted = [...pool];
        const num = (r: ImpactRow, k: string): number => (r as any)[k];
        sorted.sort((a, b) => {
            let diff = 0;
            if (this.sortCol === "name")       diff = a.name.localeCompare(b.name);
            else if (this.sortCol === "body")  diff = a.body.localeCompare(b.body);
            else if (this.sortCol === "date")  diff = a.date.localeCompare(b.date);
            else if (this.sortCol === "verdict") diff = a.proximity - b.proximity;
            else                               diff = num(a, this.sortCol) - num(b, this.sortCol);
            return this.sortAsc ? diff : -diff;
        });

        if (hazFirst) {
            sorted = [...sorted.filter(r => r.hazardous), ...sorted.filter(r => !r.hazardous)];
        }

        const truncated = sorted.length > MAX_ROWS;
        if (truncated) sorted = sorted.slice(0, MAX_ROWS);

        // Scrollable wrapper
        const wrap = this.container.append("div")
            .classed("impact-table-wrap", true)
            .style("overflow-y", "auto").style("overflow-x", "auto")
            .style("height", "calc(100% - 64px)");

        const table = wrap.append("table")
            .style("border-collapse", "collapse").style("width", "100%")
            .style("font-size", "11px").style("color", "#cdd5ee");

        type ColDef = { key: string; label: string; title: string; align: string };
        const cols: ColDef[] = [
            { key: "hazardous", label: "⚠",          title: "Potentially Hazardous",            align: "center" },
            { key: "name",      label: "Asteroid",    title: "Asteroid name",                    align: "left"   },
            { key: "body",      label: "Target",      title: "Body it would strike",             align: "left"   },
            { key: "date",      label: "Approach",    title: "Close-approach date of this encounter", align: "left" },
            { key: "verdict",   label: "Verdict",     title: "DIRECT = nominal hit · WITHIN-ERROR = hit possible inside uncertainty", align: "center" },
            { key: "missKm",    label: "Miss (km)",   title: "Propagated centre-to-centre miss distance (planet position included)", align: "right" },
            { key: "missLunar", label: "Miss (LD)",   title: "Miss distance in lunar distances (1 LD = 384,400 km)", align: "right" },
            { key: "captureKm", label: "Capture R (km)", title: "Gravitational capture radius = R · √(1 + (v_esc/v_ca)²)", align: "right" },
            { key: "errorKm",   label: "± Error (km)", title: "Positional uncertainty at chosen σ",            align: "right" },
            { key: "marginKm",  label: "Margin (km)", title: "miss − error − capture radius. ≤0 ⇒ impact possible", align: "right" },
            { key: "occ",       label: "OCC",         title: "Orbit condition code (0=certain, 9=uncertain)", align: "center" },
            { key: "vCa",       label: "v (km/s)",    title: "Velocity at closest approach",     align: "right"  },
            { key: "moidAU",    label: "MOID (AU)",   title: "Minimum orbit intersection distance (orbit-to-orbit)", align: "right" },
            { key: "diameterM", label: "Diam (km)",   title: "Max diameter (km)",                align: "right"  },
        ];

        const thead = table.append("thead");
        const hrow  = thead.append("tr").style("background", "#0b1025");
        const self  = this;

        cols.forEach(col => {
            hrow.append("th")
                .attr("title", col.title)
                .style("padding", "6px 9px")
                .style("text-align", col.align)
                .style("border-bottom", "2px solid #1e2a4a")
                .style("color", this.sortCol === col.key ? "#4fc3f7" : "#8899bb")
                .style("cursor", "pointer").style("white-space", "nowrap").style("user-select", "none")
                .html(col.label + (this.sortCol === col.key ? (this.sortAsc ? " ▲" : " ▼") : ""))
                .on("click", function() {
                    if (self.sortCol === col.key) self.sortAsc = !self.sortAsc;
                    else { self.sortCol = col.key; self.sortAsc = col.key === "marginKm"; }
                    self.renderTable();
                });
        });

        const tbody = table.append("tbody");

        sorted.forEach((row, ri) => {
            const baseBg = ri % 2 === 0 ? "#07091a" : "#090c22";
            const tr = tbody.append("tr")
                .style("background", baseBg)
                .style("border-bottom", "1px solid #111830");
            tr.on("mouseover", function() { d3.select(this).style("background", "#111d3a"); })
              .on("mouseout",  function() { d3.select(this).style("background", baseBg); });

            const td = (content: string, align = "left", color?: string, title?: string) => {
                const cell = tr.append("td")
                    .style("padding", "5px 9px").style("text-align", align).style("white-space", "nowrap");
                if (color) cell.style("color", color);
                if (title) cell.attr("title", title);
                cell.html(content);
            };

            td(row.hazardous
                ? `<span style="color:#ff4444;font-weight:bold" title="Potentially Hazardous">⚠</span>`
                : `<span style="color:#334466">–</span>`, "center");

            // Name
            tr.append("td")
                .style("padding", "5px 9px").style("max-width", "190px")
                .style("overflow", "hidden").style("text-overflow", "ellipsis").style("white-space", "nowrap")
                .style("color", row.hazardous ? "#ff8888" : "#b0c4de")
                .attr("title", row.name)
                .text(row.shortName || row.name);

            // Target body chip
            const bodyColor = row.body === "Earth" ? "#4caf50"
                : row.body === "Mars" ? "#ff7043"
                : row.body === "Venus" ? "#ffd54f"
                : row.body === "Mercury" ? "#b0bec5"
                : row.body === "Moon" ? "#cfd8dc"
                : "#4fc3f7";
            td(`${row.bodyEmoji} ${row.body}`, "left", bodyColor);

            td(row.date, "left", "#9fb0d8");

            // Verdict badge
            const vStyle = row.verdict === "DIRECT"
                ? { bg: "#5a0000", fg: "#ff5555", label: "DIRECT HIT" }
                : row.verdict === "WITHIN-ERROR"
                ? { bg: "#3a2a00", fg: "#ffc04d", label: "WITHIN ERROR" }
                : { bg: "#0a1f2a", fg: "#5fb8c8", label: "NEAR MISS" };
            tr.append("td")
                .style("padding", "5px 9px").style("text-align", "center").style("white-space", "nowrap")
                .append("span")
                .style("padding", "1px 6px").style("border-radius", "3px").style("font-size", "10px")
                .style("font-weight", "bold")
                .style("background", vStyle.bg)
                .style("color", vStyle.fg)
                .text(vStyle.label);

            td(d3.format(",.0f")(row.missKm),    "right", "#9fb0d8");

            // Miss in lunar distances — highlight the genuinely close ones (< 1 LD)
            const ldColor = row.missLunar < 1 ? "#ff6666"
                : row.missLunar < 5 ? "#ffa500" : "#9fb0d8";
            td(row.missLunar < 10 ? row.missLunar.toFixed(2) : row.missLunar.toFixed(1),
               "right", ldColor, `${row.missLunar.toFixed(3)} lunar distances`);

            td(d3.format(",.0f")(row.captureKm), "right", "#80cbc4");
            td(d3.format(",.0f")(row.errorKm),   "right", "#ffe082");

            // Margin — negative = deeper impact
            const marginColor = row.marginKm <= -row.captureKm ? "#ff4444"
                : row.marginKm <= 0 ? "#ff8a65" : "#9fb0d8";
            td(d3.format(",.0f")(row.marginKm), "right", marginColor,
               "miss − error − capture radius");

            const occColor = row.occ === 0 ? "#4fc3f7" : row.occ <= 2 ? "#ffe082" : "#ff8a65";
            td(String(row.occ), "center", occColor);

            td(row.vCa.toFixed(2), "right", "#9fb0d8");
            td(row.moidAU > 0 ? row.moidAU.toFixed(5) : "—", "right", "#9fb0d8",
               "Minimum orbit-to-orbit separation");
            td(row.diameterM > 0 ? (row.diameterM / 1000).toFixed(2) : "—", "right", "#9fb0d8");
        });

        // Footer / methodology
        this.container.append("div")
            .style("padding", "5px 14px")
            .style("font-size", "9px").style("color", "#445577")
            .style("border-top", "1px solid #111830")
            .style("line-height", "1.5")
            .html(
                (truncated ? `<span style="color:#ffb74d">Showing top ${MAX_ROWS} of ${pool.length} rows. </span>` : "") +
                "<b>Impact test:</b> miss − error ≤ capture radius. " +
                "<b>Miss distance</b> is NASA's propagated asteroid-to-body distance at the close-approach instant — " +
                "the body's actual orbital position at that time is already included. " +
                "<b>Capture radius</b> = R<sub>body</sub> · √(1 + (v<sub>esc</sub>/v<sub>ca</sub>)²) — the gravitational-focusing impact cross-section. " +
                "<b>Error</b> = 2% · (OCC+1) · σ of the miss distance. Click a header to sort."
            );
    }

    // -----------------------------------------------------------------------
    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    public destroy(): void { /* no persistent DOM outside container */ }
}
