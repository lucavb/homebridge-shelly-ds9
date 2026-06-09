import { CharacteristicValue } from 'homebridge';
import { CharacteristicValue as ShelliesCharacteristicValue, Rgbw } from '@lucavb/shellies-ds9';

import { hsvToRgb, rgbToHsv } from '../utils/color';
import { Ability, ServiceClass } from './base';

export const RGBW_WHITE_COLOR_TEMPERATURE_MIREDS = Math.round(1_000_000 / 4500);

export class RgbwLightAbility extends Ability {
    private whiteMode = false;

    constructor(readonly component: Rgbw) {
        super(`RGBW Light ${component.id + 1}`, `rgbw-light-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.Lightbulb;
    }

    protected initialize() {
        this.whiteMode = this.component.white > 0;

        const s = this.service;
        const c = this.Characteristic;

        s.setCharacteristic(c.On, this.component.output);
        s.setCharacteristic(c.Brightness, this.readBrightness());

        const hsv = rgbToHsv(this.component.rgb[0], this.component.rgb[1], this.component.rgb[2]);
        s.setCharacteristic(c.Hue, hsv.h);
        s.setCharacteristic(c.Saturation, hsv.s);

        if (this.whiteMode) {
            s.setCharacteristic(c.ColorTemperature, RGBW_WHITE_COLOR_TEMPERATURE_MIREDS);
        }

        s.getCharacteristic(c.On).onSet(this.onSetHandler.bind(this));
        s.getCharacteristic(c.Brightness).onSet(this.brightnessSetHandler.bind(this));
        s.getCharacteristic(c.Hue).onSet(this.hueSetHandler.bind(this));
        s.getCharacteristic(c.Saturation).onSet(this.saturationSetHandler.bind(this));
        s.getCharacteristic(c.ColorTemperature).onSet(this.colorTemperatureSetHandler.bind(this));

        this.component.on('change:output', this.outputChangeHandler, this);
        this.component.on('change:brightness', this.brightnessChangeHandler, this);
        this.component.on('change:rgb', this.rgbChangeHandler, this);
        this.component.on('change:white', this.whiteChangeHandler, this);
    }

    detach() {
        this.component
            .off('change:output', this.outputChangeHandler, this)
            .off('change:brightness', this.brightnessChangeHandler, this)
            .off('change:rgb', this.rgbChangeHandler, this)
            .off('change:white', this.whiteChangeHandler, this);
    }

    protected readBrightness(): number {
        if (this.component.output && this.component.white > 0) {
            return Math.round((this.component.white / 255) * 100);
        }
        return this.component.brightness;
    }

    protected syncColorFromRgb() {
        const hsv = rgbToHsv(this.component.rgb[0], this.component.rgb[1], this.component.rgb[2]);
        this.service.updateCharacteristic(this.Characteristic.Hue, hsv.h);
        this.service.updateCharacteristic(this.Characteristic.Saturation, hsv.s);
    }

    protected syncColorTemperature() {
        if (this.component.white > 0) {
            this.service.updateCharacteristic(
                this.Characteristic.ColorTemperature,
                RGBW_WHITE_COLOR_TEMPERATURE_MIREDS,
            );
        }
    }

    protected async onSetHandler(value: CharacteristicValue) {
        if (value === this.component.output) {
            return;
        }

        try {
            if (this.whiteMode) {
                const white = this.component.white;
                await this.component.set(value as boolean, 0, [0, 0, 0], white);
            } else {
                await this.component.set(value as boolean);
            }
        } catch (e) {
            this.log.error('Failed to set RGBW light:', e instanceof Error ? e.message : e);
            throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
        }
    }

    protected async brightnessSetHandler(value: CharacteristicValue) {
        const brightness = value as number;

        try {
            if (this.whiteMode) {
                const white = Math.round((brightness / 100) * 255);
                if (white === this.component.white) {
                    return;
                }
                await this.component.set(undefined, 0, [0, 0, 0], white);
            } else {
                if (brightness === this.component.brightness) {
                    return;
                }
                await this.component.set(undefined, brightness, undefined, 0);
            }
        } catch (e) {
            this.log.error('Failed to set RGBW light brightness:', e instanceof Error ? e.message : e);
            throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
        }
    }

    protected async hueSetHandler(value: CharacteristicValue) {
        this.whiteMode = false;
        await this.applyHueSaturation(
            value as number,
            this.service.getCharacteristic(this.Characteristic.Saturation).value as number,
        );
    }

    protected async saturationSetHandler(value: CharacteristicValue) {
        this.whiteMode = false;
        await this.applyHueSaturation(
            this.service.getCharacteristic(this.Characteristic.Hue).value as number,
            value as number,
        );
    }

    protected async colorTemperatureSetHandler(value: CharacteristicValue) {
        if (value === null || value === undefined) {
            return;
        }

        this.whiteMode = true;
        const brightness = this.service.getCharacteristic(this.Characteristic.Brightness).value as number;
        const white = Math.round((brightness / 100) * 255);

        if (this.component.white === white && this.component.rgb.every((v) => v === 0)) {
            return;
        }

        try {
            await this.component.set(undefined, 0, [0, 0, 0], white);
        } catch (e) {
            this.log.error('Failed to set RGBW light white channel:', e instanceof Error ? e.message : e);
            throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
        }
    }

    protected async applyHueSaturation(hue: number, saturation: number) {
        const { r, g, b } = hsvToRgb(hue, saturation, 100);

        if (
            this.component.rgb[0] === r &&
            this.component.rgb[1] === g &&
            this.component.rgb[2] === b &&
            this.component.white === 0
        ) {
            return;
        }

        try {
            await this.component.set(undefined, undefined, [r, g, b], 0);
        } catch (e) {
            this.log.error('Failed to set RGBW light color:', e instanceof Error ? e.message : e);
            throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
        }
    }

    protected outputChangeHandler(value: ShelliesCharacteristicValue) {
        this.service.updateCharacteristic(this.Characteristic.On, value as boolean);
    }

    protected brightnessChangeHandler() {
        this.service.updateCharacteristic(this.Characteristic.Brightness, this.readBrightness());
    }

    protected rgbChangeHandler() {
        if (this.component.white === 0) {
            this.whiteMode = false;
            this.syncColorFromRgb();
        }
    }

    protected whiteChangeHandler(value: ShelliesCharacteristicValue) {
        const white = value as number;
        if (white > 0) {
            this.whiteMode = true;
            this.syncColorTemperature();
        }
        this.service.updateCharacteristic(this.Characteristic.Brightness, this.readBrightness());
    }
}
