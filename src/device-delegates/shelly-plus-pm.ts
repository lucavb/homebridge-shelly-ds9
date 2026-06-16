import { ShellyPlusPmMini, ShellyPlusPmMiniV3 } from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

import { Pm1Ability } from '../abilities/index.ts';

/**
 * Handles Shelly Plus 1PM devices.
 */
export class ShellyPlusPmDelegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyPlusPmMini;

        this.createAccessory('switch', this.device.id, new Pm1Ability(d.pm1));
    }
}

DeviceDelegate.registerDelegate(ShellyPlusPmDelegate, ShellyPlusPmMini, ShellyPlusPmMiniV3);
