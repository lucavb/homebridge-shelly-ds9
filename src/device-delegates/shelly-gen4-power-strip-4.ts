import { ShellyPowerStrip4G4, ShellyPowerStrip4G4Black } from '@lucavb/shellies-ds9';

import { DeviceDelegate } from './base.ts';

/**
 * Handles Shelly Power Strip 4 Gen4 devices.
 */
export class ShellyPowerStrip4G4Delegate extends DeviceDelegate {
    protected setup() {
        const d = this.device as ShellyPowerStrip4G4;

        this.addSwitch(d.switch0);
        this.addSwitch(d.switch1);
        this.addSwitch(d.switch2);
        this.addSwitch(d.switch3);
    }
}

DeviceDelegate.registerDelegate(ShellyPowerStrip4G4Delegate, ShellyPowerStrip4G4, ShellyPowerStrip4G4Black);
