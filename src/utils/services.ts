import { API, Service, WithUUID } from 'homebridge';

import { CustomCharacteristics } from './characteristics.ts';

type S = WithUUID<typeof Service>;

export interface CustomServices {
    PowerMeter: S;
    Pm1: S;
    ThreePhaseMeter: S;
}

/**
 * Returns a set of custom HomeKit services.
 * @param api - A reference to the homebridge API.
 * @param characteristics - Custom characteristics used with these services.
 */
export const createServices = (api: API, characteristics: CustomCharacteristics): CustomServices => {
    /**
     * Reports power meter readings.
     */
    class PowerMeter extends api.hap.Service {
        static readonly UUID = 'DEDBEA44-11ED-429C-BD75-9A2286AA8707';

        constructor(displayName?: string, subtype?: string) {
            super(displayName, PowerMeter.UUID, subtype);

            this.addCharacteristic(characteristics.CurrentConsumption);

            this.addOptionalCharacteristic(characteristics.TotalConsumption);
            this.addOptionalCharacteristic(characteristics.ElectricCurrent);
            this.addOptionalCharacteristic(characteristics.Voltage);
        }
    }
    /**
     * Reports Pm1 readings.
     */
    class Pm1 extends api.hap.Service {
        static readonly UUID = 'DEDBEA44-11ED-429C-BD75-9A2286AA8707';

        constructor(displayName?: string, subtype?: string) {
            super(displayName, Pm1.UUID, subtype);

            this.addCharacteristic(characteristics.CurrentConsumption);
            this.addOptionalCharacteristic(characteristics.TotalConsumption);
            this.addOptionalCharacteristic(characteristics.ElectricCurrent);
            this.addOptionalCharacteristic(characteristics.Voltage);
        }
    }

    /**
     * Reports three-phase energy meter readings.
     */
    class ThreePhaseMeter extends api.hap.Service {
        static readonly UUID = 'A6F2EAB1-2D4A-4E2B-9AC3-6A7E611CA001';

        constructor(displayName?: string, subtype?: string) {
            super(displayName, ThreePhaseMeter.UUID, subtype);

            this.addCharacteristic(characteristics.SignedNetPower);

            this.addOptionalCharacteristic(characteristics.CurrentConsumption);
            this.addOptionalCharacteristic(characteristics.ElectricCurrent);
            this.addOptionalCharacteristic(characteristics.Voltage);
            this.addOptionalCharacteristic(characteristics.TotalConsumption);
            this.addOptionalCharacteristic(characteristics.ExportedEnergy);
        }
    }

    return {
        PowerMeter,
        Pm1,
        ThreePhaseMeter,
    };
};
