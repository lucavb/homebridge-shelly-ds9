import { Shelly3EM63Gen3, ShellyPro3EM } from '@lucavb/shellies-ds9';

import { EnergyMeterAbility } from '../abilities/energy-meter.ts';
import { DeviceDelegate } from './base.ts';

/**
 * Supports the active topology reported by shellies-ds9 1.9.0. The meter
 * accessory has a topology-independent ID so a restart after a profile change
 * updates that accessory instead of detaching/replacing it as a different one.
 */
export class ShellyEnergyMeterDelegate extends DeviceDelegate {
    private detached = false;

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
        // A reported relay can be bound immediately; cached relay removal
        // requires a complete status response confirming absence.
        const cachedSwitchAccessory = this.getCachedSwitchAccessory(device);
        if (device.switch0) {
            this.addSwitch(device.switch0);
        }

        this.device.rpcHandler.on('statusUpdate', this.handleMeterProfileUpdate, this);

        // An absent optional component is ambiguous until a successful full
        // GetStatus response confirms the inventory. Re-query on startup before
        // unregistering any cached relay accessory.
        if (device.model === ShellyPro3EM.model && !device.switch0 && cachedSwitchAccessory) {
            void this.reconcileCachedRelay(device as ShellyPro3EM);
        }
    }

    private getCachedSwitchAccessory(device: ShellyPro3EM | Shelly3EM63Gen3) {
        const accessoryUuid = this.platform.api.hap.uuid.generate(`${device.id}-switch-0`);
        const cachedAccessory = this.platform.getAccessory(accessoryUuid);
        const cachedDeviceId = (cachedAccessory?.context as { device?: { id?: unknown } } | undefined)?.device?.id;
        return cachedDeviceId === device.id ? cachedAccessory : undefined;
    }

    private async reconcileCachedRelay(device: ShellyPro3EM) {
        if (!device.rpcHandler.connected) {
            return;
        }

        const cachedAccessory = this.getCachedSwitchAccessory(device);
        if (!cachedAccessory) {
            return;
        }

        let status: Record<string, unknown>;
        try {
            const response: unknown = await device.call('Shelly.GetStatus');
            if (!this.isCompleteMeterStatus(device, response)) {
                this.log.debug('Could not confirm complete energy-meter status; keeping cached switch accessory');
                return;
            }
            status = response;
        } catch {
            this.log.debug('Could not confirm optional relay inventory; keeping cached switch accessory');
            return;
        }

        if (this.detached || !device.rpcHandler.connected) {
            return;
        }

        // Only an explicit full-status inventory can prove absence. A status
        // notification omitting switch:0 is partial and never reaches here.
        const switchStatus = status['switch:0'];
        if (switchStatus !== undefined) {
            if (!this.isRecord(switchStatus)) {
                return;
            }
            if (!this.accessories.has('switch-0')) {
                // A partial seed may have missed the component even though the
                // full status confirms it; loadStatus seeds the library component.
                if (!device.switch0) {
                    try {
                        await device.loadStatus();
                    } catch {
                        this.log.debug('Could not initialize confirmed optional relay component');
                        return;
                    }
                    if (this.detached || !device.rpcHandler.connected) {
                        return;
                    }
                }
                // A status notification can construct and adopt the relay
                // while loadStatus is in flight; never add it twice.
                if (device.switch0 && !this.accessories.has('switch-0')) {
                    this.addSwitch(device.switch0);
                }
            }
            return;
        }

        // A later status notification may have constructed the relay while the
        // full-status request was in flight. Never remove its cached accessory.
        if (device.switch0) {
            if (!this.accessories.has('switch-0')) {
                this.addSwitch(device.switch0);
            }
            return;
        }

        this.platform.removeAccessory(cachedAccessory);
        this.log.info('Removed cached optional relay accessory; complete status confirms no switch add-on');
    }

    private isCompleteMeterStatus(device: ShellyPro3EM, status: unknown): status is Record<string, unknown> {
        if (!this.isRecord(status)) {
            return false;
        }

        if (device.meterProfile === 'triphase') {
            return this.isRecord(status['em:0']) && this.isRecord(status['emdata:0']);
        }

        if (device.meterProfile === 'monophase') {
            return [0, 1, 2].every(
                (id) => this.isRecord(status[`em1:${id}`]) && this.isRecord(status[`em1data:${id}`]),
            );
        }

        return false;
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    private handleMeterProfileUpdate() {
        const device = this.device as ShellyPro3EM | Shelly3EM63Gen3;
        if (device.switch0 && !this.accessories.has('switch-0')) {
            this.addSwitch(device.switch0);
        }

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
        this.detached = true;
        this.device.rpcHandler.off('statusUpdate', this.handleMeterProfileUpdate, this);
        super.detach();
    }
}

DeviceDelegate.registerDelegate(ShellyEnergyMeterDelegate, ShellyPro3EM, Shelly3EM63Gen3);
