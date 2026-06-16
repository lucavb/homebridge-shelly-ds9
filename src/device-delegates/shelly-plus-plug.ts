import {
    ShellyOutdoorPlugSG3Eu,
    ShellyPlugAzG3Eu,
    ShellyPlugMG3Eu,
    ShellyPlugPmG3Eu,
    ShellyPlugSG3Eu,
    ShellyPlugUsG4,
    ShellyPlusPlugUs,
    ShellyPlusPlugEu,
    ShellyPlusPlugIt,
    ShellyPlusPlugUk,
} from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

/**
 * Handles Shelly Plus Plug US devices.
 */
export class ShellyPlusPlugUsDelegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyPlusPlugUs;

        this.addSwitch(d.switch0, { single: true });
    }
}

DeviceDelegate.registerDelegate(
    ShellyPlusPlugUsDelegate,
    ShellyPlusPlugUs,
    ShellyPlusPlugEu,
    ShellyPlusPlugIt,
    ShellyPlusPlugUk,
    ShellyPlugSG3Eu,
    ShellyPlugAzG3Eu,
    ShellyOutdoorPlugSG3Eu,
    ShellyPlugMG3Eu,
    ShellyPlugPmG3Eu,
    ShellyPlugUsG4,
);
