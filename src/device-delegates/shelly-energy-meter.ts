import { Shelly3EM63Gen3, ShellyPro3EM } from '@lucavb/shellies-ds9';

import { EnergyMeterAbility } from '../abilities/energy-meter.ts';
import { DeviceDelegate } from './base.ts';

/**
 * Supports the active topology reported by shellies-ds9 1.9.0. The meter
 * accessory has a topology-independent ID so a restart after a profile change
 * updates that accessory instead of detaching/replacing it as a different one.
 */
export class ShellyEnergyMeterDelegate extends DeviceDelegate {
    protected setup() {
        const device = this.device as ShellyPro3EM | Shelly3EM63Gen3;
        const profile = device.meterProfile;

        if (profile === 'triphase' && device.em) {
            this.createAccessory(
                'energy-meter',
                null,
                new EnergyMeterAbility('triphase', { meter: device.em, data: device.emdata }),
            );
        } else if (profile === 'monophase' && device.em1) {
            const [meterA, meterB, meterC] = device.em1;
            const data = device.em1data;
            this.createAccessory(
                'energy-meter',
                null,
                new EnergyMeterAbility('monophase', [
                    { meter: meterA, data: data?.[0] },
                    { meter: meterB, data: data?.[1] },
                    { meter: meterC, data: data?.[2] },
                ]),
            );
        } else {
            this.log.warn(
                'Energy meter topology is not known yet; restart Homebridge after the device reports a meter profile',
            );
        }

        // Profile changes replace component objects. Restarting Homebridge is
        // required to bind the new topology and reconcile phase services.
        if (profile) {
            this.log.info(
                `Using ${profile} energy-meter profile; restart Homebridge after changing the Shelly profile`,
            );
        }

        // The Pro 3EM's switch add-on is optional. Never manufacture a relay
        // accessory for the 3EM-63 or for a Pro 3EM without that component.
        if (device.switch0) {
            this.addSwitch(device.switch0);
        }

        this.device.rpcHandler.on('statusUpdate', this.handleMeterProfileUpdate, this);
    }

    private handleMeterProfileUpdate() {
        const meterAbilities = [...this.accessories.values()].flatMap((accessory) =>
            accessory.abilities.filter(
                (ability): ability is EnergyMeterAbility => ability instanceof EnergyMeterAbility,
            ),
        );
        const staleAbilities = meterAbilities.filter((ability) =>
            ability.hasReplacedComponents((key) => this.device.getComponent(key)),
        );

        if (staleAbilities.length === 0) {
            return;
        }

        this.device.rpcHandler.off('statusUpdate', this.handleMeterProfileUpdate, this);
        for (const ability of staleAbilities) {
            ability.markStale();
        }
        this.log.warn('Energy-meter profile changed; readings are unavailable until Homebridge restarts');
    }

    detach() {
        this.device.rpcHandler.off('statusUpdate', this.handleMeterProfileUpdate, this);
        super.detach();
    }
}

DeviceDelegate.registerDelegate(ShellyEnergyMeterDelegate, ShellyPro3EM, Shelly3EM63Gen3);
