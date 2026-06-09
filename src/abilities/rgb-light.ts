import { CharacteristicValue } from 'homebridge';
import { CharacteristicValue as ShelliesCharacteristicValue, Rgb } from '@lucavb/shellies-ds9';

import { hsvToRgb, rgbToHsv } from '../utils/color';
import { Ability, ServiceClass } from './base';

export class RgbLightAbility extends Ability {
    constructor(readonly component: Rgb) {
        super(`RGB Light ${component.id + 1}`, `rgb-light-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.Lightbulb;
    }

    protected initialize() {
        const s = this.service;
        const c = this.Characteristic;

        s.setCharacteristic(c.On, this.component.output);
        s.setCharacteristic(c.Brightness, this.component.brightness);

        const hsv = rgbToHsv(this.component.rgb[0], this.component.rgb[1], this.component.rgb[2]);
        s.setCharacteristic(c.Hue, hsv.h);
        s.setCharacteristic(c.Saturation, hsv.s);

        s.getCharacteristic(c.On).onSet(this.onSetHandler.bind(this));
        s.getCharacteristic(c.Brightness).onSet(this.brightnessSetHandler.bind(this));
        s.getCharacteristic(c.Hue).onSet(this.hueSetHandler.bind(this));
        s.getCharacteristic(c.Saturation).onSet(this.saturationSetHandler.bind(this));

        this.component.on('change:output', this.outputChangeHandler, this);
        this.component.on('change:brightness', this.brightnessChangeHandler, this);
        this.component.on('change:rgb', this.rgbChangeHandler, this);
    }

    detach() {
        this.component
            .off('change:output', this.outputChangeHandler, this)
            .off('change:brightness', this.brightnessChangeHandler, this)
            .off('change:rgb', this.rgbChangeHandler, this);
    }

    protected syncColorFromRgb() {
        const hsv = rgbToHsv(this.component.rgb[0], this.component.rgb[1], this.component.rgb[2]);
        this.service.updateCharacteristic(this.Characteristic.Hue, hsv.h);
        this.service.updateCharacteristic(this.Characteristic.Saturation, hsv.s);
    }

    protected async onSetHandler(value: CharacteristicValue) {
        if (value === this.component.output) {
            return;
        }

        try {
            await this.component.set(value as boolean);
        } catch (e) {
            this.log.error('Failed to set RGB light:', e instanceof Error ? e.message : e);
            throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
        }
    }

    protected async brightnessSetHandler(value: CharacteristicValue) {
        if (value === this.component.brightness) {
            return;
        }

        try {
            await this.component.set(undefined, value as number);
        } catch (e) {
            this.log.error('Failed to set RGB light brightness:', e instanceof Error ? e.message : e);
            throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
        }
    }

    protected async hueSetHandler(value: CharacteristicValue) {
        await this.applyHueSaturation(
            value as number,
            this.service.getCharacteristic(this.Characteristic.Saturation).value as number,
        );
    }

    protected async saturationSetHandler(value: CharacteristicValue) {
        await this.applyHueSaturation(
            this.service.getCharacteristic(this.Characteristic.Hue).value as number,
            value as number,
        );
    }

    protected async applyHueSaturation(hue: number, saturation: number) {
        const { r, g, b } = hsvToRgb(hue, saturation, 100);

        if (this.component.rgb[0] === r && this.component.rgb[1] === g && this.component.rgb[2] === b) {
            return;
        }

        try {
            await this.component.set(undefined, undefined, [r, g, b]);
        } catch (e) {
            this.log.error('Failed to set RGB light color:', e instanceof Error ? e.message : e);
            throw this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
        }
    }

    protected outputChangeHandler(value: ShelliesCharacteristicValue) {
        this.service.updateCharacteristic(this.Characteristic.On, value as boolean);
    }

    protected brightnessChangeHandler(value: ShelliesCharacteristicValue) {
        this.service.updateCharacteristic(this.Characteristic.Brightness, value as number);
    }

    protected rgbChangeHandler() {
        this.syncColorFromRgb();
    }
}
