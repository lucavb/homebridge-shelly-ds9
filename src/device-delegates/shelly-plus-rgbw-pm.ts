import { ShellyPlusRgbwPm } from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base';

/**
 * Handles Shelly Plus RGBW PM devices.
 */
export class ShellyPlusRgbwPmDelegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyPlusRgbwPm;

        if (d.profile === 'light') {
            this.addLight(d.light0);
            this.addLight(d.light1);
            this.addLight(d.light2);
            this.addLight(d.light3);
        } else if (d.profile === 'rgb') {
            this.addRgbLight(d.rgb0, { single: true });
        } else if (d.profile === 'rgbw') {
            this.addRgbwLight(d.rgbw0, { single: true });
        } else {
            this.log.warn(`Unsupported or missing profile "${d.profile}" — no accessories created`);
        }
    }
}

DeviceDelegate.registerDelegate(ShellyPlusRgbwPmDelegate, ShellyPlusRgbwPm);
