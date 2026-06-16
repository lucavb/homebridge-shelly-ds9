import { ShellyPro1, ShellyPro1Rev1, ShellyPro1Rev2, ShellyPro1Rev2Ul } from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

/**
 * Handles Shelly Pro 1 devices.
 */
export class ShellyPro1Delegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyPro1;

        this.addSwitch(d.switch0, { single: true });
    }
}

DeviceDelegate.registerDelegate(ShellyPro1Delegate, ShellyPro1, ShellyPro1Rev1, ShellyPro1Rev2, ShellyPro1Rev2Ul);
