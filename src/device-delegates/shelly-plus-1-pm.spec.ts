import { describe, expect, it, vi } from 'vitest';
import { uuid } from '@homebridge/hap-nodejs';
import { Device, Ogemray25A, RpcHandler, type RpcStatusNotification } from '@lucavb/shellies-ds9';

import type { Accessory } from '../accessory.ts';
import type { DeviceOptions } from '../config.ts';
import type { ShellyPlatform } from '../platform.ts';
import { DeviceDelegate } from './base.ts';
import { ShellyPlus1PmDelegate } from './shelly-plus-1-pm.ts';

class TestRpcHandler extends RpcHandler {
    constructor() {
        super('test');
    }

    connected = true;
    request = vi.fn().mockResolvedValue({});
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

describe('Shelly Plus 1 PM delegates', () => {
    it('registers the Ogemray Smart Relay 25A from the library', () => {
        expect(Ogemray25A.model).toBe('S3PB-O3AR000001');
        expect(Device.getClass(Ogemray25A.model)).toBe(Ogemray25A);
        expect(DeviceDelegate.getDelegate(Ogemray25A.model)).toBe(ShellyPlus1PmDelegate);
    });

    it('creates one switch accessory for the Ogemray relay', () => {
        const device = new Ogemray25A(
            { id: 'ogemray25a-test', mac: 'test', model: Ogemray25A.model },
            new TestRpcHandler(),
        );
        device.applyInitialStatus({
            ts: 1,
            'switch:0': { id: 0, output: true, apower: 12.3 },
        } as RpcStatusNotification);

        const options: DeviceOptions = { exclude: false, protocol: 'websocket' };
        const delegate = new ShellyPlus1PmDelegate(device, options, createPlatform());
        const accessories = getAccessories(delegate);

        expect([...accessories.keys()]).toEqual(['switch']);
        expect(accessories.get('switch')?.active).toBe(true);

        delegate.detach();
    });
});
