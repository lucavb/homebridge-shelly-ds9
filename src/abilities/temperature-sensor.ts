import { CharacteristicValue as ShelliesCharacteristicValue, Temperature } from '@lucavb/shellies-ds9';

import { Ability, ServiceClass } from './base.ts';

/** DS18B20 operating range upper bound (°C); HAP CurrentTemperature defaults to 100. */
const DS18B20_MAX_CELSIUS = 125;

/**
 * Exposes a Shelly temperature component as a HomeKit temperature sensor.
 */
export class TemperatureSensorAbility extends Ability {
    constructor(readonly component: Temperature) {
        super(`Temperature ${component.id}`, `temperature-sensor-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.TemperatureSensor;
    }

    protected initialize() {
        const characteristic = this.service.getCharacteristic(this.Characteristic.CurrentTemperature);
        characteristic.setProps({ maxValue: DS18B20_MAX_CELSIUS });
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

        characteristic.updateValue(Math.min(value, DS18B20_MAX_CELSIUS));
    }
}
