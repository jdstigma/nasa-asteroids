"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard  = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

class DisplayCard extends FormattingSettingsCard {
    showAllPlanets = new formattingSettings.ToggleSwitch({
        name:         "showAllPlanets",
        displayName:  "Show All 8 Planets",
        value:        true,
    });

    animationSpeed = new formattingSettings.NumUpDown({
        name:        "animationSpeed",
        displayName: "Animation Speed (days/frame)",
        value:       5,
        options:     { minValue: { value: 1, type: powerbi.visuals.ValidatorType.Min },
                       maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max } },
    });

    showHazardousOnly = new formattingSettings.ToggleSwitch({
        name:        "showHazardousOnly",
        displayName: "Hazardous Asteroids Only",
        value:       false,
    });

    name:  string = "display";
    displayName: string = "Display Options";
    slices = [this.showAllPlanets, this.animationSpeed, this.showHazardousOnly];
}

export class VisualSettings extends FormattingSettingsModel {
    display = new DisplayCard();
    cards   = [this.display];
}
