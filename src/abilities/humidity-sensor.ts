import { CharacteristicValue as ShelliesCharacteristicValue, Humidity } from '@lucavb/shellies-ds9';

import { Ability, ServiceClass } from './base.ts';

/**
 * Exposes a Shelly humidity component as a HomeKit humidity sensor.
 */
export class HumiditySensorAbility extends Ability {
    constructor(readonly component: Humidity) {
        super(`Humidity ${component.id}`, `humidity-sensor-${component.id}`);
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.HumiditySensor;
    }

    protected initialize() {
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
    }
}
