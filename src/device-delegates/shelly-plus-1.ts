import {
    Shelly1LGen3,
    ShellyGen4One,
    ShellyGen4OneAnz,
    ShellyGen4OneMini,
    ShellyPlus1,
    ShellyPlus1Ul,
    ShellyPlus1V3,
    ShellyPlus1Mini,
    ShellyPlus1MiniV3,
} from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

/**
 * Handles Shelly Plus 1 devices.
 */
export class ShellyPlus1Delegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyPlus1;

        this.addSwitch(d.switch0, { single: true });
    }
}

DeviceDelegate.registerDelegate(
    ShellyPlus1Delegate,
    ShellyPlus1,
    ShellyPlus1Ul,
    ShellyPlus1V3,
    ShellyPlus1Mini,
    ShellyPlus1MiniV3,
    ShellyGen4One,
    ShellyGen4OneMini,
    ShellyGen4OneAnz,
    Shelly1LGen3,
);
