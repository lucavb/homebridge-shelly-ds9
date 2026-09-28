import { CharacteristicValue as ShelliesCharacteristicValue, Humidity } from '@lucavb/shellies-ds9';
import { Categories } from 'homebridge';

import { Ability, ServiceClass } from './base.ts';
import type { HistoryKind } from '../history.ts';

/**
 * Exposes a Shelly humidity component as a HomeKit humidity sensor.
 */
export class HumiditySensorAbility extends Ability {
    private readonly historyEnabled: boolean;

    /**
     * @param component - The humidity component to expose.
     * @param options - The options for this ability. A missing `history` flag
     *   means that history is enabled.
     */
    constructor(
        readonly component: Humidity,
        options?: { history?: boolean },
    ) {
        super(`Humidity ${component.id}`, `humidity-sensor-${component.id}`);

        this.historyEnabled = options?.history !== false;
    }

    get historyKind(): HistoryKind | undefined {
        return this.historyEnabled ? 'humidity' : undefined;
    }

    get category(): Categories {
        return Categories.SENSOR;
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.HumiditySensor;
    }

    protected initialize() {
        // this setup-time seeding produces the initial history entry, if any
        this.updateHumidity(this.component.rh);

        this.component.on('change:rh', this.humidityChangeHandler, this);
    }

    detach() {
        this.component.off('change:rh', this.humidityChangeHandler, this);
    }

    protected humidityChangeHandler(value: ShelliesCharacteristicValue) {
        this.updateHumidity(value);
    }

    private updateHumidity(value: ShelliesCharacteristicValue) {
        const characteristic = this.service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity);

        if (value === null || typeof value !== 'number' || Number.isNaN(value)) {
            characteristic.updateValue(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY));
            return;
        }

        characteristic.updateValue(value);

        if (Number.isFinite(value)) {
            this.record('humidity', value);
        }
    }
}
