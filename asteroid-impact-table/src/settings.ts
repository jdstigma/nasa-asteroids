"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard  = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

class DisplayCard extends FormattingSettingsCard {
    sigmaLevel = new formattingSettings.NumUpDown({
        name:        "sigmaLevel",
        displayName: "Uncertainty Confidence (σ)",
        value:       3,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 9, type: powerbi.visuals.ValidatorType.Max },
        },
    });

    gravFocus = new formattingSettings.ToggleSwitch({
        name:        "gravFocus",
        displayName: "Apply Gravitational Focusing",
        value:       true,
    });

    impactsOnly = new formattingSettings.ToggleSwitch({
        name:        "impactsOnly",
        displayName: "Show Impacts Only",
        value:       true,
    });

    earthOnly = new formattingSettings.ToggleSwitch({
        name:        "earthOnly",
        displayName: "Earth Approaches Only",
        value:       false,
    });

    hazardousFirst = new formattingSettings.ToggleSwitch({
        name:        "hazardousFirst",
        displayName: "Hazardous Asteroids First",
        value:       true,
    });

    name:        string = "display";
    displayName: string = "Display Options";
    slices = [this.sigmaLevel, this.gravFocus, this.impactsOnly, this.earthOnly, this.hazardousFirst];
}

export class VisualSettings extends FormattingSettingsModel {
    display = new DisplayCard();
    cards   = [this.display];
}
