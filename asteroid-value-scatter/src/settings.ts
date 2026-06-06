"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard  = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

class DisplayCard extends FormattingSettingsCard {
    showHazardousOnly = new formattingSettings.ToggleSwitch({
        name:        "showHazardousOnly",
        displayName: "Hazardous Asteroids Only",
        value:       false,
    });

    highlightQuadrant = new formattingSettings.ToggleSwitch({
        name:        "highlightQuadrant",
        displayName: "Highlight High-Value Zone",
        value:       true,
    });

    maxMissDistAU = new formattingSettings.NumUpDown({
        name:        "maxMissDistAU",
        displayName: "Max Miss Distance to Show (AU)",
        value:       2.0,
        options: {
            minValue: { value: 0.01, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 2.0,  type: powerbi.visuals.ValidatorType.Max },
        },
    });

    // Largest dot radius (px). Bigger value = stronger size contrast between
    // the closest and farthest approaches.
    maxPointSize = new formattingSettings.NumUpDown({
        name:        "maxPointSize",
        displayName: "Max Dot Size (px)",
        value:       20,
        options: {
            minValue: { value: 6,  type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 48, type: powerbi.visuals.ValidatorType.Max },
        },
    });

    // How sharply dot size grows as approaches get closer. 1 = area-true (gentle),
    // higher = exaggerates the difference between near and far points.
    sizeContrast = new formattingSettings.NumUpDown({
        name:        "sizeContrast",
        displayName: "Size Contrast (1 = subtle, 3 = strong)",
        value:       1.5,
        options: {
            minValue: { value: 0.5, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 4,   type: powerbi.visuals.ValidatorType.Max },
        },
    });

    showCatchable = new formattingSettings.ToggleSwitch({
        name:        "showCatchable",
        displayName: "Mark 'Catchable' Asteroids",
        value:       true,
    });

    // Log velocity (X) axis spreads out the slow asteroids where the catchable
    // cutoff lives — otherwise they bunch against the left edge on a linear scale.
    logVelocityAxis = new formattingSettings.ToggleSwitch({
        name:        "logVelocityAxis",
        displayName: "Log Velocity (X) Axis",
        value:       true,
    });

    showTrendLine = new formattingSettings.ToggleSwitch({
        name:        "showTrendLine",
        displayName: "Show Trend Line",
        value:       true,
    });

    // "Catchable" = approach speed below this limit (km/h).
    // Default 28,000 km/h ≈ 7.8 km/s = typical low-Earth-orbit satellite speed.
    catchableKmh = new formattingSettings.NumUpDown({
        name:        "catchableKmh",
        displayName: "Catchable Speed Limit (km/h)",
        value:       28000,
        options: {
            minValue: { value: 0,      type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 400000, type: powerbi.visuals.ValidatorType.Max },
        },
    });

    name:        string = "display";
    displayName: string = "Display Options";
    slices = [this.showHazardousOnly, this.highlightQuadrant, this.maxMissDistAU,
              this.maxPointSize, this.sizeContrast, this.showCatchable, this.catchableKmh,
              this.logVelocityAxis, this.showTrendLine];
}

export class VisualSettings extends FormattingSettingsModel {
    display = new DisplayCard();
    cards   = [this.display];
}
