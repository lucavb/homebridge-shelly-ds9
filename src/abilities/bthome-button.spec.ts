import { describe, expect, it, vi } from 'vitest';
import { Characteristic, Service, uuid } from '@homebridge/hap-nodejs';
import { Categories } from 'homebridge';
import { DynamicComponent } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { DeviceLogger } from '../utils/device-logger.ts';
import { ShellyPlatform } from '../platform.ts';
import { BTHomeButtonAbility } from './bthome-button.ts';

function setupAbility(index: number) {
    const component = new DynamicComponent({} as never, {
        key: 'bthomedevice:200',
        rpcName: 'BTHomeDevice',
        kind: 'unknown',
        id: 200,
    });
    component.config = { addr: '3c:2e:f5:71:d5:2a' };
    component.device = {
        getComponent: (key: string) => (key === component.key ? component : undefined),
        [Symbol.iterator]: function* () {
            yield [component.key, component];
        },
    } as never;
    const ability = new BTHomeButtonAbility(component, index, '3c:2e:f5:71:d5:2a');
    const platform = {
        log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        api: { hap: { uuid, Characteristic, Service } },
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
    const accessory = {
        getServiceById: () => undefined,
        addService: (serviceClass: typeof Service.StatelessProgrammableSwitch, name?: string, subtype?: string) =>
            new serviceClass(name, subtype),
        getService: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;
    const log = new DeviceLogger({ id: 'shellyplus1-test' } as never, 'Test', platform.log);
    ability.setup(accessory, platform, log);
    const characteristic = ability['service'].getCharacteristic(Characteristic.ProgrammableSwitchEvent);
    return { ability, characteristic, component };
}

describe('BTHomeButtonAbility', () => {
    it('requires the verified RPC event envelope and maps supported per-index events', async () => {
        const { ability, characteristic, component } = setupAbility(0);
        expect(ability.category).toBe(Categories.PROGRAMMABLE_SWITCH);
        const topLevelEvent = (name: string, idx = 0) =>
            component.emit('event', {
                component: 'bthomedevice:200',
                event: name,
                idx,
                ts: 1711200000.52,
            });
        const nestedEvent = (name: string, idx = 0) =>
            component.emit('event', {
                component: 'bthomedevice:200',
                event: name,
                data: { idx, channel: -1, sensors: null },
                ts: 1711200000.52,
            });
        const update = vi.spyOn(characteristic, 'updateValue');
        topLevelEvent('single_push');
        await Promise.resolve();
        expect(characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
        nestedEvent('single_push');
        await Promise.resolve();
        expect(update).toHaveBeenCalledTimes(2);
        topLevelEvent('double_push');
        await Promise.resolve();
        expect(characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
        nestedEvent('long_push');
        await Promise.resolve();
        expect(characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
        const previous = characteristic.value;
        topLevelEvent('single_push', 1);
        component.emit('event', { component: 'bthomedevice:201', event: 'single_push', idx: 0, ts: 1711200000.52 });
        component.emit('event', {
            component: 'bthomedevice:200',
            event: 'single_push',
            idx: 0,
            data: { idx: 1 },
            ts: 1711200000.52,
        });
        nestedEvent('triple_push');
        expect(characteristic.value).toBe(previous);
        ability.detach();
    });

    it('accepts the dispatcher base-component event form routed by numeric id', async () => {
        const { ability, characteristic, component } = setupAbility(0);
        const update = vi.spyOn(characteristic, 'updateValue');
        // ds9's event handler resolves `component + ':' + id` when the event
        // names the base component with a numeric id instead of the full key.
        component.emit('event', {
            component: 'bthomedevice',
            id: 200,
            event: 'long_push',
            idx: 0,
            ts: 1711200000.53,
        });
        await Promise.resolve();
        expect(characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.LONG_PRESS);

        // A base-component form with a mismatching id must still be rejected.
        component.emit('event', {
            component: 'bthomedevice',
            id: 201,
            event: 'single_push',
            idx: 0,
            ts: 1711200000.54,
        });
        await Promise.resolve();
        expect(update).toHaveBeenCalledTimes(1);
        ability.detach();
    });

    it('creates stable independent services for distinct known button indexes', async () => {
        const first = setupAbility(0);
        const secondAbility = new BTHomeButtonAbility(first.component, 1, '3c:2e:f5:71:d5:2a');
        const accessory = {
            getServiceById: () => undefined,
            addService: (serviceClass: typeof Service.StatelessProgrammableSwitch, name?: string, subtype?: string) =>
                new serviceClass(name, subtype),
            getService: () => undefined,
            removeService: vi.fn(),
        } as unknown as PlatformAccessory;
        const platform = {
            log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
            api: { hap: { uuid, Characteristic, Service } },
            customCharacteristics: {},
            customServices: {},
        } as unknown as ShellyPlatform;
        secondAbility.setup(
            accessory,
            platform,
            new DeviceLogger({ id: 'shellyplus1-test' } as never, 'Test', platform.log),
        );
        const second = secondAbility['service'].getCharacteristic(Characteristic.ProgrammableSwitchEvent);
        first.component.emit('event', {
            component: 'bthomedevice:200',
            id: 200,
            event: 'double_push',
            idx: 0,
            ts: 1711200000.51,
        });
        first.component.emit('event', {
            component: 'bthomedevice:200',
            id: 200,
            event: 'single_push',
            idx: 1,
            ts: 1711200000.52,
        });
        await Promise.resolve();
        expect(second.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
        expect(first.characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
        first.ability.detach();
        secondAbility.detach();
    });

    it('detaches event listeners', () => {
        const { ability, component } = setupAbility(0);
        const off = vi.spyOn(component, 'off');
        ability.detach();
        expect(off).toHaveBeenCalledWith('event', expect.any(Function), ability);
    });

    it('does not publish a queued event after detaching', async () => {
        const { ability, characteristic, component } = setupAbility(0);
        const update = vi.spyOn(characteristic, 'updateValue');
        component.emit('event', {
            component: component.key,
            id: 200,
            event: 'single_push',
            idx: 0,
            ts: 1711200000,
        });
        ability.detach();
        await Promise.resolve();
        expect(update).not.toHaveBeenCalled();
    });

    it('ignores valid-shaped envelopes whose ts is missing or not a number', async () => {
        const { ability, characteristic, component } = setupAbility(0);
        const update = vi.spyOn(characteristic, 'updateValue');

        // Control: the matching idx and numeric ts publish the event.
        component.emit('event', {
            component: 'bthomedevice:200',
            event: 'single_push',
            idx: 0,
            ts: 1711200000.55,
        });
        await Promise.resolve();
        expect(characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        component.emit('event', { component: 'bthomedevice:200', event: 'double_push', idx: 0 });
        component.emit('event', { component: 'bthomedevice:200', event: 'double_push', idx: 0, ts: '1711200000' });
        await Promise.resolve();
        expect(update).toHaveBeenCalledTimes(1);
        expect(characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
        ability.detach();
    });

    it('ignores non-object event payloads', async () => {
        const { ability, characteristic, component } = setupAbility(0);
        const update = vi.spyOn(characteristic, 'updateValue');
        // An array payload carries otherwise-valid fields but must never be
        // treated as an event envelope.
        const arrayEnvelope: string[] = [];
        Object.assign(arrayEnvelope, {
            component: 'bthomedevice:200',
            event: 'double_push',
            idx: 0,
            ts: 1711200000.56,
        });

        component.emit('event', 'single_push');
        component.emit('event', 1711200000.56);
        component.emit('event', arrayEnvelope);
        component.emit('event', null);
        await Promise.resolve();
        expect(update).not.toHaveBeenCalled();
        expect(characteristic.value).toBe(0);
        ability.detach();
    });

    it('publishes a matching-idx envelope with the canonical valid form', async () => {
        const { ability, characteristic, component } = setupAbility(0);
        component.emit('event', {
            component: 'bthomedevice:200',
            event: 'long_push',
            idx: 0,
            ts: 1711200000.57,
        });
        await Promise.resolve();
        expect(characteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
        ability.detach();
    });
});
