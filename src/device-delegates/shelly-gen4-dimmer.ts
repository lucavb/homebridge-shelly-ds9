import { ShellyDimmerGen4, ShellyDimmerGen4US } from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

/**
 * Handles Shelly Dimmer Gen4 EU and US devices.
 */
export class ShellyDimmerGen4Delegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyDimmerGen4 | ShellyDimmerGen4US;

        this.addLight(d.light0, { single: true });
    }
}

DeviceDelegate.registerDelegate(ShellyDimmerGen4Delegate, ShellyDimmerGen4, ShellyDimmerGen4US);
