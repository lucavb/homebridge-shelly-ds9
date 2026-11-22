import { describe, expect, it, vi } from 'vitest';
import { uuid } from '@homebridge/hap-nodejs';
import { Device, RpcHandler, ShellyDimmerGen4, ShellyDimmerGen4US } from '@lucavb/shellies-ds9';

import '../platform.ts';
import { LightAbility } from '../abilities/index.ts';
import { Accessory } from '../accessory.ts';
import { DeviceOptions } from '../config.ts';
import { ShellyPlatform } from '../platform.ts';
import { DeviceDelegate } from './base.ts';
import { ShellyDimmerGen4Delegate } from './shelly-gen4-dimmer.ts';

class TestRpcHandler extends RpcHandler {
    constructor() {
        super('test');
    }

    connected = true;
    request = vi.fn().mockResolvedValue({});
}

function createDevice(DeviceClass: typeof ShellyDimmerGen4 | typeof ShellyDimmerGen4US): Device {
    return new DeviceClass(
        {
            id: 'shellydimmerg4-test',
            mac: 'test',
            model: DeviceClass.model,
        },
        new TestRpcHandler(),
    );
}

function createPlatform(): ShellyPlatform {
    return {
        log: { log: vi.fn() },
        api: { hap: { uuid } },
        getAccessory: vi.fn().mockReturnValue(null),
    } as unknown as ShellyPlatform;
}

function getAccessories(delegate: DeviceDelegate): Map<string, Accessory> {
    return (delegate as unknown as { accessories: Map<string, Accessory> }).accessories;
}

function expectSingleLightAccessory(device: Device & { light0: ShellyDimmerGen4['light0'] }) {
    const options: DeviceOptions = { exclude: false, protocol: 'websocket' };
    const delegate = new ShellyDimmerGen4Delegate(device, options, createPlatform());
    const accessories = getAccessories(delegate);

    expect([...accessories.keys()]).toEqual(['light']);
    const lightAbility = accessories
        .get('light')
        ?.abilities.find((ability): ability is LightAbility => ability instanceof LightAbility);
    expect(lightAbility?.component).toBe(device.light0);

    delegate.detach();
}

describe('Shelly Dimmer Gen4 delegates', () => {
    it('registers the EU and US device models', () => {
        expect(DeviceDelegate.getDelegate(ShellyDimmerGen4.model)).toBe(ShellyDimmerGen4Delegate);
        expect(DeviceDelegate.getDelegate(ShellyDimmerGen4US.model)).toBe(ShellyDimmerGen4Delegate);
    });

    it('creates one single-light accessory for the EU device', () => {
        expectSingleLightAccessory(createDevice(ShellyDimmerGen4) as ShellyDimmerGen4);
    });

    it('creates one single-light accessory for the US device', () => {
        expectSingleLightAccessory(createDevice(ShellyDimmerGen4US) as ShellyDimmerGen4US);
    });
});
