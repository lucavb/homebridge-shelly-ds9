import { ShellyGen4Mini } from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

/**
 * Handles Shelly 1PM Gen4 Mini devices.
 */
export class ShellyGen4MiniDelegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyGen4Mini;

        this.addSwitch(d.switch, { single: true });
    }
}

DeviceDelegate.registerDelegate(ShellyGen4MiniDelegate, ShellyGen4Mini);
