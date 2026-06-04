"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import FormattingSettingsCard  = formattingSettings.SimpleCard;
import FormattingSettingsModel = formattingSettings.Model;

class DisplayCard extends FormattingSettingsCard {
    showAllPlanets = new formattingSettings.ToggleSwitch({
        name: "showAllPlanets", displayName: "Show All 8 Planets", value: true,
    });

    animationSpeed = new formattingSettings.NumUpDown({
        name: "animationSpeed", displayName: "Animation Speed (days/frame)", value: 1,
        options: { minValue: { value: 0.25, type: powerbi.visuals.ValidatorType.Min },
                   maxValue: { value: 100,  type: powerbi.visuals.ValidatorType.Max } },
    });

    lineThreshold = new formattingSettings.NumUpDown({
        name: "lineThreshold", displayName: "Orbit Line Density (0 = many, 1 = few)", value: 0.55,
        options: { minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
                   maxValue: { value: 1, type: powerbi.visuals.ValidatorType.Max } },
    });

    showHazardousOnly = new formattingSettings.ToggleSwitch({
        name: "showHazardousOnly", displayName: "Hazardous Asteroids Only", value: false,
    });

    name: string = "display";
    displayName: string = "Display Options";
    slices = [this.showAllPlanets, this.animationSpeed, this.lineThreshold, this.showHazardousOnly];
}

export class VisualSettings extends FormattingSettingsModel {
    display = new DisplayCard();
    cards   = [this.display];
}
