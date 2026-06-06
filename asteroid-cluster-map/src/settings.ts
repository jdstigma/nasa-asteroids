"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard  = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

class DisplayCard extends FormattingSettingsCard {
    numClusters = new formattingSettings.NumUpDown({
        name:        "numClusters",
        displayName: "Number of Clusters (k)",
        value:       5,
        options: {
            minValue: { value: 2, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 8, type: powerbi.visuals.ValidatorType.Max },
        },
    });

    showEllipses = new formattingSettings.ToggleSwitch({
        name:        "showEllipses",
        displayName: "Show Error Ellipses (1σ)",
        value:       true,
    });

    showHazardousOnly = new formattingSettings.ToggleSwitch({
        name:        "showHazardousOnly",
        displayName: "Hazardous Asteroids Only",
        value:       false,
    });

    // Matches the Impact Table's confidence level so "would hit" agrees across visuals.
    sigmaLevel = new formattingSettings.NumUpDown({
        name:        "sigmaLevel",
        displayName: "Impact Confidence (σ) — matches Impact Table",
        value:       3,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 9, type: powerbi.visuals.ValidatorType.Max },
        },
    });

    showTrendLine = new formattingSettings.ToggleSwitch({
        name:        "showTrendLine",
        displayName: "Show Trend Line",
        value:       true,
    });

    name:        string = "display";
    displayName: string = "Display Options";
    slices = [this.numClusters, this.showEllipses, this.showHazardousOnly, this.sigmaLevel, this.showTrendLine];
}

export class VisualSettings extends FormattingSettingsModel {
    display = new DisplayCard();
    cards   = [this.display];
}
