import { CharacteristicValue as ShelliesCharacteristicValue, Temperature } from '@lucavb/shellies-ds9';
import { Categories } from 'homebridge';

import { Ability, ServiceClass } from './base.ts';
import type { HistoryKind } from '../history.ts';

/** DS18B20 operating range upper bound (°C); HAP CurrentTemperature defaults to 100. */
const DS18B20_MAX_CELSIUS = 125;

/**
 * Exposes a Shelly temperature component as a HomeKit temperature sensor.
 */
export class TemperatureSensorAbility extends Ability {
    private readonly historyEnabled: boolean;

    /**
     * @param component - The temperature component to expose.
     * @param options - The options for this ability. A missing `history` flag
     *   means that history is enabled.
     */
    constructor(
        readonly component: Temperature,
        options?: { history?: boolean },
    ) {
        super(`Temperature ${component.id}`, `temperature-sensor-${component.id}`);

        this.historyEnabled = options?.history !== false;
    }

    get historyKind(): HistoryKind | undefined {
        return this.historyEnabled ? 'temperature' : undefined;
    }

    get category(): Categories {
        return Categories.SENSOR;
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.TemperatureSensor;
    }

    protected initialize() {
        const characteristic = this.service.getCharacteristic(this.Characteristic.CurrentTemperature);
        characteristic.setProps({ maxValue: DS18B20_MAX_CELSIUS });
        // this setup-time seeding produces the initial history entry, if any
        this.updateTemperature(this.component.tC);

        this.component.on('change:tC', this.temperatureChangeHandler, this);
    }

    detach() {
        this.component.off('change:tC', this.temperatureChangeHandler, this);
    }

    protected temperatureChangeHandler(value: ShelliesCharacteristicValue) {
        this.updateTemperature(value);
    }

    private updateTemperature(value: ShelliesCharacteristicValue) {
        const characteristic = this.service.getCharacteristic(this.Characteristic.CurrentTemperature);

        if (value === null || typeof value !== 'number' || Number.isNaN(value)) {
            characteristic.updateValue(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY));
            return;
        }

        const tC = Math.min(value, DS18B20_MAX_CELSIUS);

        characteristic.updateValue(tC);

        if (Number.isFinite(tC)) {
            this.record('temperature', tC);
        }
    }
}
