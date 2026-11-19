import {
    Device,
    ShellyGen4OnePm,
    ShellyGen4OnePmAnz,
    ShellyPlus1Pm,
    ShellyPlus1PmUl,
    ShellyPlus1PmV3,
    ShellyPlus1PmMini,
    ShellyPlus1PmMiniV3,
} from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

/**
 * Ogemray Smart Relay 25A (SW40 PbS).
 *
 * Powered-by-Shelly Gen3 device with the same components as Shelly Plus 1PM
 * (`switch:0` including power metering). Registered locally because
 * `@lucavb/shellies-ds9` does not ship this model yet.
 */
export class Ogemray25A extends ShellyPlus1Pm {
    static readonly model = 'S3PB-O3AR000001';
    static readonly modelName = 'Ogemray Smart Relay 25A';
}

if (Device.getClass(Ogemray25A.model) === undefined) {
    Device.registerClass(Ogemray25A);
}

/**
 * Handles Shelly Plus 1PM devices.
 */
export class ShellyPlus1PmDelegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyPlus1Pm;

        this.addSwitch(d.switch0, { single: true });
    }
}

DeviceDelegate.registerDelegate(
    ShellyPlus1PmDelegate,
    ShellyPlus1Pm,
    ShellyPlus1PmUl,
    ShellyPlus1PmV3,
    ShellyPlus1PmMini,
    ShellyPlus1PmMiniV3,
    ShellyGen4OnePm,
    ShellyGen4OnePmAnz,
    Ogemray25A,
);
