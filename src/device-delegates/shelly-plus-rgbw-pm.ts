import { Light, ShellyPlusRGBWPM } from '@lucavb/shellies-ds9';
import { CharacteristicValue } from 'homebridge';

import { LightAbility } from '../abilities/light.ts';
import { RGBLightAbility } from '../abilities/rgb-light.ts';
import { LightOptions } from '../config.ts';
import { DeviceDelegate } from './base.ts';

/**
 * Handles the Shelly Plus RGBW PM's profile-specific lighting topologies.
 * RGB and RGBW profiles share one stable color-light accessory; the `light`
 * profile uses the standard per-component accessories. Profile changes require
 * a Homebridge restart so accessory identities and services can be rebuilt.
 */
export class ShellyPlusRGBWPmDelegate extends DeviceDelegate {
    protected setup() {
        const device = this.device as ShellyPlusRGBWPM;
        this.reconcileCachedLightingAccessories(device);

        if (device.rgbw) {
            this.addColorLight(device.rgbw);
        } else if (device.rgb) {
            this.addColorLight(device.rgb);
        } else {
            for (const light of [device.light0, device.light1, device.light2, device.light3]) {
                if (light) {
                    this.addProfileLight(light);
                }
            }
        }

        this.device.rpcHandler.on('statusUpdate', this.handleLightingProfileUpdate, this);
    }

    /** Removes only the opposite known topology after the current topology is complete. */
    private reconcileCachedLightingAccessories(device: ShellyPlusRGBWPM) {
        const hasRgbw = device.rgbw !== undefined;
        const hasRgb = device.rgb !== undefined;
        const lights = [device.light0, device.light1, device.light2, device.light3];
        let staleIds: string[] | undefined;

        if (hasRgbw !== hasRgb && lights.every((light) => light === undefined)) {
            staleIds = ['light-0', 'light-1', 'light-2', 'light-3'];
        } else if (!hasRgbw && !hasRgb && lights.every((light) => light !== undefined)) {
            staleIds = ['light'];
        }

        if (!staleIds) {
            return;
        }

        for (const staleId of staleIds) {
            const uuid = this.platform.api.hap.uuid.generate(`${device.id}-${staleId}`);
            const cachedAccessory = this.platform.getAccessory(uuid);
            if (cachedAccessory) {
                this.platform.removeAccessory(cachedAccessory);
            }
        }
    }

    private addColorLight(component: ShellyPlusRGBWPM['rgbw'] | ShellyPlusRGBWPM['rgb']) {
        if (!component) {
            return;
        }

        const componentOptions = this.getComponentOptions<LightOptions>(component) ?? {};
        this.createAccessory('light', null, new RGBLightAbility(component)).setActive(
            componentOptions.exclude !== true,
        );
    }

    /** Uses addLight's established identity/exclusion rules with a stale guard. */
    private addProfileLight(light: Light) {
        this.addLight(light, { lightAbility: RestartAwareLightAbility });
    }

    /** Detaches the old profile's listeners; restart to rebuild its accessories. */
    private handleLightingProfileUpdate() {
        const lightingAccessories = [...this.accessories.entries()].filter(
            ([id]) => id === 'light' || /^light-\d+$/.test(id),
        );

        const hasStaleComponent = lightingAccessories.some(([, accessory]) =>
            accessory.abilities.some((ability) => {
                const component = (ability as { component?: { key: string } }).component;
                return component !== undefined && this.device.getComponent(component.key) !== component;
            }),
        );

        if (!hasStaleComponent) {
            return;
        }

        this.device.rpcHandler.off('statusUpdate', this.handleLightingProfileUpdate, this);
        for (const [, accessory] of lightingAccessories) {
            for (const ability of accessory.abilities) {
                if (ability instanceof RGBLightAbility || ability instanceof RestartAwareLightAbility) {
                    ability.markStale();
                }
                ability.detach();
            }
        }
        this.log.warn('Lighting profile changed; restart Homebridge to apply the new profile');
    }

    detach() {
        this.device.rpcHandler.off('statusUpdate', this.handleLightingProfileUpdate, this);
        super.detach();
    }
}

DeviceDelegate.registerDelegate(ShellyPlusRGBWPmDelegate, ShellyPlusRGBWPM);

/** LightAbility variant that can reject HomeKit commands after a profile swap. */
class RestartAwareLightAbility extends LightAbility {
    private stale = false;

    markStale() {
        this.stale = true;
    }

    protected async onSetHandler(value: CharacteristicValue) {
        this.assertAvailable();
        await super.onSetHandler(value);
    }

    protected async brightnessSetHandler(value: CharacteristicValue) {
        this.assertAvailable();
        await super.brightnessSetHandler(value);
    }

    private assertAvailable() {
        if (this.stale) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }
}
