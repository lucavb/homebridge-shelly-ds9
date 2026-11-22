import { Categories, CharacteristicValue } from 'homebridge';
import { CharacteristicValue as ShelliesCharacteristicValue, RGB, RGBW } from '@lucavb/shellies-ds9';
import type { Characteristic as HAPCharacteristic, CharacteristicChange } from 'homebridge';

import { Ability, ServiceClass } from './base.ts';

export type RGBColor = [red: number, green: number, blue: number];
export type HSVColor = [hue: number, saturation: number, value: number];

const DEFAULT_RGB: RGBColor = [255, 255, 255];

/** Converts 8-bit RGB channels to HomeKit's degree / percent hue and saturation. */
export function rgbToHsv([red, green, blue]: RGBColor): HSVColor {
    const r = clampChannel(red) / 255;
    const g = clampChannel(green) / 255;
    const b = clampChannel(blue) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
        if (max === r) {
            hue = 60 * (((g - b) / delta) % 6);
        } else if (max === g) {
            hue = 60 * ((b - r) / delta + 2);
        } else {
            hue = 60 * ((r - g) / delta + 4);
        }
    }

    if (hue < 0) {
        hue += 360;
    }

    return [hue, max === 0 ? 0 : (delta / max) * 100, max * 100];
}

/** Converts HomeKit hue, saturation, and value percent to 8-bit RGB channels. */
export function hsvToRgb(hue: number, saturation: number, value: number): RGBColor {
    const h = ((hue % 360) + 360) % 360;
    const s = clampPercent(saturation) / 100;
    const v = clampPercent(value) / 100;
    const chroma = v * s;
    const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - chroma;

    let channels: [number, number, number];
    if (h < 60) {
        channels = [chroma, x, 0];
    } else if (h < 120) {
        channels = [x, chroma, 0];
    } else if (h < 180) {
        channels = [0, chroma, x];
    } else if (h < 240) {
        channels = [0, x, chroma];
    } else if (h < 300) {
        channels = [x, 0, chroma];
    } else {
        channels = [chroma, 0, x];
    }

    return channels.map((channel) => Math.round((channel + m) * 255)) as RGBColor;
}

function clampChannel(value: number): number {
    return Math.max(0, Math.min(255, value));
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
}

/** HomeKit colour light backed by either an RGB or RGBW Shelly output. */
export class RGBLightAbility extends Ability {
    private desiredHue: number;
    private desiredSaturation: number;
    private confirmedHue: number;
    private confirmedSaturation: number;
    private pendingColorWrites = 0;
    private colorWriteQueue: Promise<void> = Promise.resolve();
    private colorWriteGeneration = 0;
    private pendingDeviceColor: RGBColor | null = null;
    private pendingDeviceColorVersion = 0;
    private hueWritebackListener: ((change: CharacteristicChange) => void) | null = null;
    private saturationWritebackListener: ((change: CharacteristicChange) => void) | null = null;
    private attached = false;
    private stale = false;

    constructor(readonly component: RGB | RGBW) {
        super(`Color Light ${component.id + 1}`, `rgb-light-${component.id}`);
        const initialRgb: RGBColor = component.rgb ? [...component.rgb] : [...DEFAULT_RGB];
        const [hue, saturation] = rgbToHsv(initialRgb);
        this.desiredHue = hue;
        this.desiredSaturation = saturation;
        this.confirmedHue = hue;
        this.confirmedSaturation = saturation;
    }

    get category(): Categories {
        return Categories.LIGHTBULB;
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.Lightbulb;
    }

    protected initialize() {
        this.colorWriteGeneration++;
        this.attached = true;
        // Seed only values that were actually reported. Some firmware omits
        // brightness, in which case leave HAP's existing/default value intact.
        if (typeof this.component.output === 'boolean') {
            this.service.setCharacteristic(this.Characteristic.On, this.component.output);
        }
        if (typeof this.component.brightness === 'number' && Number.isFinite(this.component.brightness)) {
            this.service.setCharacteristic(this.Characteristic.Brightness, this.component.brightness);
        }
        this.service.setCharacteristic(this.Characteristic.Hue, this.confirmedHue);
        this.service.setCharacteristic(this.Characteristic.Saturation, this.confirmedSaturation);

        this.service.getCharacteristic(this.Characteristic.On).onSet(this.onSetHandler.bind(this));
        this.service.getCharacteristic(this.Characteristic.Brightness).onSet(this.brightnessSetHandler.bind(this));
        const hue = this.service.getCharacteristic(this.Characteristic.Hue);
        const saturation = this.service.getCharacteristic(this.Characteristic.Saturation);
        hue.onSet(this.hueSetHandler.bind(this));
        saturation.onSet(this.saturationSetHandler.bind(this));
        hue.onGet(this.hueGetHandler.bind(this));
        saturation.onGet(this.saturationGetHandler.bind(this));

        const generation = this.colorWriteGeneration;
        this.hueWritebackListener = (change) => {
            if (generation === this.colorWriteGeneration && this.attached && change.reason === 'write') {
                this.correctHapWriteback(hue, change.newValue, this.confirmedHue);
            }
        };
        this.saturationWritebackListener = (change) => {
            if (generation === this.colorWriteGeneration && this.attached && change.reason === 'write') {
                this.correctHapWriteback(saturation, change.newValue, this.confirmedSaturation);
            }
        };
        hue.on('change', this.hueWritebackListener);
        saturation.on('change', this.saturationWritebackListener);

        this.component.on('change:output', this.outputChangeHandler, this);
        this.component.on('change:brightness', this.brightnessChangeHandler, this);
        this.component.on('change:rgb', this.rgbChangeHandler, this);
    }

    detach() {
        if (this.attached && this.serviceReady) {
            if (this.hueWritebackListener) {
                this.service.getCharacteristic(this.Characteristic.Hue).off('change', this.hueWritebackListener);
            }
            if (this.saturationWritebackListener) {
                this.service
                    .getCharacteristic(this.Characteristic.Saturation)
                    .off('change', this.saturationWritebackListener);
            }
        }
        this.attached = false;
        this.colorWriteGeneration++;
        this.pendingColorWrites = 0;
        this.pendingDeviceColor = null;
        this.pendingDeviceColorVersion++;
        this.hueWritebackListener = null;
        this.saturationWritebackListener = null;
        this.component.off('change:output', this.outputChangeHandler, this);
        this.component.off('change:brightness', this.brightnessChangeHandler, this);
        this.component.off('change:rgb', this.rgbChangeHandler, this);
    }

    protected async onSetHandler(value: CharacteristicValue) {
        this.assertAvailable();
        if (typeof value !== 'boolean') {
            return;
        }
        if (value === this.component.output) {
            return;
        }
        await this.set({ on: value });
    }

    protected async brightnessSetHandler(value: CharacteristicValue) {
        this.assertAvailable();
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return;
        }
        if (value === this.component.brightness) {
            return;
        }
        await this.set({ brightness: value });
    }

    protected async hueSetHandler(value: CharacteristicValue) {
        this.assertAvailable();
        this.desiredHue = normalizeHue(value as number);
        await this.queueColorWrite();
    }

    protected async saturationSetHandler(value: CharacteristicValue) {
        this.assertAvailable();
        this.desiredSaturation = clampPercent(value as number);
        await this.queueColorWrite();
    }

    protected outputChangeHandler(value: ShelliesCharacteristicValue) {
        if (typeof value !== 'boolean') {
            return;
        }
        this.service.getCharacteristic(this.Characteristic.On).updateValue(value);
    }

    protected brightnessChangeHandler(value: ShelliesCharacteristicValue) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return;
        }
        this.service.getCharacteristic(this.Characteristic.Brightness).updateValue(value);
    }

    protected rgbChangeHandler(value: ShelliesCharacteristicValue) {
        if (!Array.isArray(value) || value.length !== 3) {
            return;
        }
        if (!value.every((channel) => typeof channel === 'number' && Number.isFinite(channel))) {
            return;
        }

        const rgb: RGBColor = [Number(value[0]), Number(value[1]), Number(value[2])];
        if (this.pendingColorWrites > 0) {
            this.pendingDeviceColor = rgb;
            this.pendingDeviceColorVersion++;
            this.setConfirmedDeviceColor(rgb);
            return;
        }

        this.applyDeviceColor(rgb);
    }

    private applyDeviceColor(rgb: RGBColor) {
        const [hue, saturation] = rgbToHsv(rgb);

        // RGB cannot encode hue when saturation is zero (including black), so
        // retain the last explicitly selected hue for later saturation writes.
        if (saturation > 0) {
            this.desiredHue = hue;
        }
        this.desiredSaturation = saturation;
        this.setConfirmedDeviceColor(rgb);
    }

    private setConfirmedDeviceColor(rgb: RGBColor, hueWhenAchromatic = this.confirmedHue) {
        const [hue, saturation] = rgbToHsv(rgb);
        if (saturation > 0) {
            this.confirmedHue = hue;
        } else {
            this.confirmedHue = hueWhenAchromatic;
        }
        this.confirmedSaturation = saturation;
        this.updateConfirmedCharacteristics();
    }

    private setConfirmedCommand(hue: number, saturation: number) {
        this.confirmedHue = hue;
        this.confirmedSaturation = saturation;
        this.updateConfirmedCharacteristics();
    }

    private updateConfirmedCharacteristics() {
        this.service.getCharacteristic(this.Characteristic.Hue).updateValue(this.confirmedHue);
        this.service.getCharacteristic(this.Characteristic.Saturation).updateValue(this.confirmedSaturation);
    }

    private hueGetHandler(): CharacteristicValue {
        this.assertAvailable();
        return this.confirmedHue;
    }

    private saturationGetHandler(): CharacteristicValue {
        this.assertAvailable();
        return this.confirmedSaturation;
    }

    private correctHapWriteback(
        characteristic: HAPCharacteristic,
        writtenValue: CharacteristicChange['newValue'],
        desiredValue: number,
    ) {
        if (writtenValue !== desiredValue) {
            characteristic.updateValue(desiredValue);
        }
    }

    /** Prevents commands from reaching a component removed by a profile switch. */
    markStale() {
        this.stale = true;
    }

    private async queueColorWrite(): Promise<void> {
        // Shelly RGB/RGBW brightness is a separate RPC field. Keep RGB as a
        // normalized color so choosing a color from black does not stay black.
        const requestedHue = this.desiredHue;
        const requestedSaturation = this.desiredSaturation;
        const rgb = hsvToRgb(requestedHue, requestedSaturation, 100);
        const generation = this.colorWriteGeneration;
        if (this.pendingColorWrites === 0) {
            this.pendingDeviceColor = null;
        }
        this.pendingColorWrites++;
        let observationVersionAtStart = 0;
        let rpcSucceeded = false;
        const write = this.colorWriteQueue.then(async () => {
            this.assertGeneration(generation);
            observationVersionAtStart = this.pendingDeviceColorVersion;
            await this.set({ rgb });
            rpcSucceeded = true;
        });
        // Keep the queue usable after a failed RPC while returning this write's
        // failure to HomeKit so it can report the communication error.
        this.colorWriteQueue = write.catch(() => undefined);
        try {
            await write;
        } finally {
            if (generation === this.colorWriteGeneration) {
                if (rpcSucceeded) {
                    // A successful later RPC supersedes observations from
                    // before it started, but a failure leaves those updates valid.
                    if (observationVersionAtStart === this.pendingDeviceColorVersion) {
                        this.pendingDeviceColor = null;
                        this.setConfirmedCommand(requestedHue, requestedSaturation);
                    } else if (this.pendingDeviceColor !== null) {
                        const currentColor = this.component.rgb;
                        this.setConfirmedDeviceColor(
                            Array.isArray(currentColor) && currentColor.length === 3
                                ? [Number(currentColor[0]), Number(currentColor[1]), Number(currentColor[2])]
                                : this.pendingDeviceColor,
                            requestedHue,
                        );
                    }
                }
                this.pendingColorWrites--;
                if (this.pendingColorWrites === 0) {
                    if (this.pendingDeviceColor !== null) {
                        this.reconcileDeviceColor();
                    } else {
                        this.updateConfirmedCharacteristics();
                    }
                }
            }
        }
    }

    private reconcileDeviceColor() {
        const observedColor = this.pendingDeviceColor;
        this.pendingDeviceColor = null;
        if (observedColor === null) {
            return;
        }

        const currentColor = this.component.rgb;
        const rgb: RGBColor =
            Array.isArray(currentColor) && currentColor.length === 3
                ? [Number(currentColor[0]), Number(currentColor[1]), Number(currentColor[2])]
                : observedColor;
        this.applyDeviceColor(rgb);
    }

    private async set(params: { on?: boolean; brightness?: number; rgb?: RGBColor }) {
        this.assertAvailable();
        try {
            await (this.component as RGB).set(params);
        } catch (e) {
            this.log.error('Failed to set RGB light:', e instanceof Error ? e.message : e);
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    private assertGeneration(generation: number) {
        if (generation !== this.colorWriteGeneration) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        this.assertAvailable();
    }

    private assertAvailable() {
        if (this.stale || !this.attached) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}

function normalizeHue(value: number): number {
    return ((value % 360) + 360) % 360;
}
