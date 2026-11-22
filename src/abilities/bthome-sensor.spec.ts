import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import { Categories } from 'homebridge';
import { DynamicComponent } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { DeviceLogger } from '../utils/device-logger.ts';
import { ShellyPlatform } from '../platform.ts';
import { BTHomeSensorAbility } from './bthome-sensor.ts';
import type { BTHomeSensorKind } from '../utils/bthome.ts';

function setupAbility(
    kind: BTHomeSensorKind,
    initial: unknown,
    deviceContext: Record<string, unknown> = {},
    timestampField: 'last_update_ts' | 'last_updated_ts' = 'last_update_ts',
    setTimestamp = true,
) {
    const component = new DynamicComponent({} as never, {
        key: 'bthomesensor:201',
        rpcName: 'BTHomeSensor',
        kind: 'unknown',
        id: 201,
    });
    component.config = {
        addr: '3c:2e:f5:71:d5:2a',
        obj_id: { temperature: 2, humidity: 3, contact: 45, motion: 33, battery: 1 }[kind],
        idx: 0,
    };
    component.device = {
        getComponent: (key: string) => (key === component.key ? component : undefined),
        [Symbol.iterator]: function* () {
            yield [component.key, component];
        },
    } as never;
    if (setTimestamp) {
        component.update({ [timestampField]: 1000 });
    }
    if (initial !== undefined) {
        component.update({ value: initial });
    }
    const objectId = { temperature: 2, humidity: 3, contact: 45, motion: 33, battery: 1 }[kind];
    const ability = new BTHomeSensorAbility(component, kind, objectId, 0, '3c:2e:f5:71:d5:2a');
    const platform = {
        log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        api: { hap: { uuid, Characteristic, Service, HAPStatus, HapStatusError } },
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
    const accessory = {
        context: { device: deviceContext },
        getServiceById: () => undefined,
        addService: (serviceClass: typeof Service, name?: string, subtype?: string) => new serviceClass(name, subtype),
        getService: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;
    const log = new DeviceLogger({ id: 'shellyplus1-test' } as never, 'Test', platform.log);
    ability.setup(accessory, platform, log);
    return { ability, component, service: ability['service'] };
}

describe('BTHomeSensorAbility', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('exposes climate measurements at BTHome precision', async () => {
        const temperature = setupAbility('temperature', 21.25);
        expect(temperature.ability.category).toBe(Categories.SENSOR);
        expect(temperature.service.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(21.25);
        expect(temperature.service.getCharacteristic(Characteristic.CurrentTemperature).props.maxValue).toBe(125);
        temperature.ability.detach();

        const humidity = setupAbility('humidity', 45);
        humidity.component.update({ value: 51.5 });
        await Promise.resolve();
        expect(humidity.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).value).toBe(51.5);
        humidity.ability.detach();
    });

    it('maps contact and motion binary semantics and updates', async () => {
        const contact = setupAbility('contact', 0);
        const contactState = contact.service.getCharacteristic(Characteristic.ContactSensorState);
        // BTHome window/contact object: 0 means closed (contact detected).
        expect(contactState.value).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
        contact.component.update({ value: 1 });
        await Promise.resolve();
        expect(contactState.value).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

        const motion = setupAbility('motion', false);
        const motionState = motion.service.getCharacteristic(Characteristic.MotionDetected);
        expect(motionState.value).toBe(false);
        motion.component.update({ value: true });
        await Promise.resolve();
        expect(motionState.value).toBe(true);
        contact.ability.detach();
        motion.ability.detach();
    });

    it('updates battery level but leaves unsupported low-battery state unavailable', async () => {
        const { ability, component, service } = setupAbility('battery', 67);
        const level = service.getCharacteristic(Characteristic.BatteryLevel);
        const low = service.getCharacteristic(Characteristic.StatusLowBattery);
        expect(level.value).toBe(67);
        expect(low.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(service.testCharacteristic(Characteristic.ChargingState)).toBe(false);
        component.update({ value: 0 });
        await Promise.resolve();
        expect(level.value).toBe(0);
        expect(low.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('marks unavailable values busy and restores only after an observation', async () => {
        const { ability, service } = setupAbility('motion', true);
        const motion = service.getCharacteristic(Characteristic.MotionDetected);
        ability.markUnavailable();
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.observeStatus(false, 1000);
        expect(motion.value).toBe(false);

        const battery = setupAbility('battery', undefined);
        const level = battery.service.getCharacteristic(Characteristic.BatteryLevel);
        expect(level.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        battery.component.update({ value: 101 });
        await Promise.resolve();
        expect(level.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
        battery.ability.detach();
    });

    it('persists the unavailable marker so a stale value cannot resurface after restart', () => {
        const deviceContext: Record<string, unknown> = {};
        const { ability, service } = setupAbility('temperature', 21, deviceContext);
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        const subtype = 'bthome-temperature-2-0';

        ability.markUnavailable();

        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect((deviceContext.bthomeUnavailableServices as Record<string, unknown>)[subtype]).toBe(true);
        expect((deviceContext.bthomeLastUpdatedTs as Record<string, unknown>)[subtype]).toBe(1000);

        // A live observation clears the persisted marker again.
        ability.observeStatus(22, 1001);
        expect(temperature.value).toBe(22);
        expect((deviceContext.bthomeUnavailableServices as Record<string, unknown>)[subtype]).toBe(false);
        ability.detach();
    });

    it('does not restore from an unchanged cached status timestamp, but accepts a newer timestamp or update event', async () => {
        const { ability, component, service } = setupAbility('motion', true);
        const motion = service.getCharacteristic(Characteristic.MotionDetected);
        ability.markDisconnected();
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(ability.observeStatus(true, null)).toBe(false);
        expect(ability.observeStatus(true, 1000)).toBe(false);
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        component.update({ last_update_ts: null });
        await Promise.resolve();
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(ability.observeStatus(true, 1001)).toBe(true);
        expect(motion.value).toBe(true);
        expect(motion.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);

        ability.markDisconnected();
        component.update({ last_update_ts: 1002 });
        await Promise.resolve();
        expect(motion.value).toBe(true);
        expect(motion.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('honors the persisted startup-unavailable marker until a newer packet timestamp arrives', () => {
        const subtype = 'bthome-temperature-2-0';
        const { ability, service } = setupAbility('temperature', 21, {
            bthomeLastUpdatedTs: { [subtype]: 1000 },
            bthomeUnavailableServices: { [subtype]: true },
        });
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(ability.observeStatus(21, 1000)).toBe(false);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(ability.observeStatus(22, 1001)).toBe(true);
        expect(temperature.value).toBe(22);
        expect(temperature.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('establishes a missing persisted disconnect watermark before accepting a newer sample', () => {
        const subtype = 'bthome-motion-33-0';
        const { ability, component, service } = setupAbility('motion', true, {
            bthomeUnavailableServices: { [subtype]: true },
        });
        const motion = service.getCharacteristic(Characteristic.MotionDetected);

        // The current component timestamp is only a baseline: startup may have
        // persisted unavailability without having persisted its timestamp.
        expect(ability.observeStatus(false, 1000)).toBe(false);
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(ability.observeStatus(false, 1001)).toBe(true);
        expect(motion.value).toBe(false);
        expect(motion.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
        component.removeAllListeners();
    });

    it.each([
        [{ addr: 'aa:bb:cc:dd:ee:ff', obj_id: 2, idx: 0 }],
        [{ addr: '3c:2e:f5:71:d5:2a', obj_id: 3, idx: 0 }],
        [{ addr: '3c:2e:f5:71:d5:2a', obj_id: 2, idx: 1 }],
    ])('rejects status from a retained key with changed sensor identity: %o', async (config) => {
        const { ability, component, service } = setupAbility('temperature', 21);
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        component.config = config;
        component.update({ value: 99, last_update_ts: 1001 });
        await Promise.resolve();

        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(temperature.value).toBe(21);
        ability.detach();
    });

    it.each([
        [{ addr: 'aa:bb:cc:dd:ee:ff', obj_id: 2, idx: 0 }],
        [{ addr: '3c:2e:f5:71:d5:2a', obj_id: 3, idx: 0 }],
        [{ addr: '3c:2e:f5:71:d5:2a', obj_id: 2, idx: 1 }],
    ])('rejects HAP GET after config-only sensor identity change: %o', async (config) => {
        const { ability, component, service } = setupAbility('temperature', 21);
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        component.config = config;

        await expect(temperature.handleGetRequest()).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
        expect(temperature.listeners('get')).toHaveLength(0);
    });

    it.each([
        ['temperature', Characteristic.CurrentTemperature, 21],
        ['humidity', Characteristic.CurrentRelativeHumidity, 45],
        ['contact', Characteristic.ContactSensorState, 1],
        ['motion', Characteristic.MotionDetected, true],
        ['battery', Characteristic.BatteryLevel, 67],
    ] as const)('guards HAP GET for stale %s sensor identity', async (kind, characteristicClass, initial) => {
        const { ability, component, service } = setupAbility(kind, initial);
        const characteristic = service.getCharacteristic(characteristicClass);
        component.config = {
            addr: 'aa:bb:cc:dd:ee:ff',
            obj_id: { temperature: 2, humidity: 3, contact: 45, motion: 33, battery: 1 }[kind],
            idx: 0,
        };

        await expect(characteristic.handleGetRequest()).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        expect(characteristic.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('applies monotonic checks to timestamp-only component updates for both RPC spellings', async () => {
        for (const timestampField of ['last_update_ts', 'last_updated_ts'] as const) {
            const subtype = 'bthome-motion-33-0';
            const { ability, component, service } = setupAbility(
                'motion',
                true,
                {
                    bthomeLastUpdatedTs: { [subtype]: 1000 },
                    bthomeUnavailableServices: { [subtype]: true },
                },
                timestampField,
            );
            const motion = service.getCharacteristic(Characteristic.MotionDetected);
            component.update({ [timestampField]: 1000 });
            await Promise.resolve();
            expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
            component.update({ [timestampField]: 1001 });
            await Promise.resolve();
            expect(motion.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
            expect(motion.value).toBe(true);
            ability.detach();
        }
    });

    it('does not recover from conflicting timestamp aliases', async () => {
        const { ability, component, service } = setupAbility('motion', true);
        const motion = service.getCharacteristic(Characteristic.MotionDetected);
        ability.markDisconnected();
        component.update({ last_updated_ts: 999 });
        await Promise.resolve();
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        component.update({ last_update_ts: 1001, last_updated_ts: 1001 });
        await Promise.resolve();
        expect(motion.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('removes its change listener on detach', () => {
        const { ability, component } = setupAbility('temperature', 20);
        const off = vi.spyOn(component, 'off');
        ability.detach();
        expect(off).toHaveBeenCalledWith('change:value', expect.any(Function), ability);
        expect(off).toHaveBeenCalledWith('change:last_update_ts', expect.any(Function), ability);
    });

    it('does not publish a queued status after detaching', async () => {
        const { ability, component, service } = setupAbility('temperature', 21);
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        const update = vi.spyOn(temperature, 'updateValue');
        component.update({ value: 99, last_update_ts: 1001 });
        ability.detach();
        await Promise.resolve();
        expect(update).not.toHaveBeenCalledWith(99);
    });

    it('publishes distinct same-turn observations in order', async () => {
        const { ability, component, service } = setupAbility('motion', false);
        const motion = service.getCharacteristic(Characteristic.MotionDetected);
        const changes: unknown[] = [];
        motion.on('change', ({ newValue }) => changes.push(newValue));

        component.update({ value: true, last_update_ts: 1001 });
        component.update({ value: false, last_update_ts: 1002 });
        await Promise.resolve();

        expect(changes).toEqual([true, false]);
        ability.detach();
    });

    it('rejects temperature readings outside [-100 °C, 125 °C] and publishes boundary values', async () => {
        const { ability, component, service } = setupAbility('temperature', 21);
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);

        component.update({ value: -150 });
        await Promise.resolve();
        expect(temperature.value).toBe(21);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        component.update({ value: 200 });
        await Promise.resolve();
        expect(temperature.value).toBe(21);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        component.update({ value: -100 });
        await Promise.resolve();
        expect(temperature.value).toBe(-100);
        expect(temperature.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);

        component.update({ value: 125 });
        await Promise.resolve();
        expect(temperature.value).toBe(125);
        ability.detach();
    });

    it('rejects humidity percentages above 100 and restores in-range readings', async () => {
        const { ability, component, service } = setupAbility('humidity', 45);
        const humidity = service.getCharacteristic(Characteristic.CurrentRelativeHumidity);

        component.update({ value: 120 });
        await Promise.resolve();
        expect(humidity.value).toBe(45);
        expect(humidity.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        component.update({ value: 55.5 });
        await Promise.resolve();
        expect(humidity.value).toBe(55.5);
        expect(humidity.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('rejects non-binary contact values', async () => {
        const { ability, component, service } = setupAbility('contact', 0);
        const contactState = service.getCharacteristic(Characteristic.ContactSensorState);

        component.update({ value: 2 });
        await Promise.resolve();
        expect(contactState.value).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
        expect(contactState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('rejects non-integer battery levels', async () => {
        const { ability, component, service } = setupAbility('battery', 67);
        const level = service.getCharacteristic(Characteristic.BatteryLevel);

        component.update({ value: 99.5 });
        await Promise.resolve();
        expect(level.value).toBe(67);
        expect(level.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        component.update({ value: 99 });
        await Promise.resolve();
        expect(level.value).toBe(99);
        expect(level.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('publishes a timestampless host observation after a disconnect and clears the freshness gate', () => {
        const { ability, service } = setupAbility('motion', true, {}, undefined, false);
        const motion = service.getCharacteristic(Characteristic.MotionDetected);

        // The host never reports a timestamp, so no disconnect watermark can
        // exist; the gated state must not be permanent.
        ability.markDisconnected();
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(ability.observeStatus(false, undefined)).toBe(true);
        expect(motion.value).toBe(false);
        expect(motion.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);

        // The gate is cleared: subsequent observations are accepted normally.
        expect(ability.observeStatus(true, undefined)).toBe(true);
        expect(motion.value).toBe(true);
        ability.detach();
    });

    it('recovers a persisted unavailable marker for a timestampless host on startup', () => {
        const subtype = 'bthome-motion-33-0';
        const deviceContext: Record<string, unknown> = {
            bthomeUnavailableServices: { [subtype]: true },
        };
        const { ability, service } = setupAbility('motion', true, deviceContext, undefined, false);
        const motion = service.getCharacteristic(Characteristic.MotionDetected);

        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(ability.observeStatus(false, undefined)).toBe(true);
        expect(motion.value).toBe(false);
        expect(motion.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        expect((deviceContext.bthomeUnavailableServices as Record<string, unknown>)[subtype]).toBe(false);
        ability.detach();
    });

    it('still rejects malformed timestamps for a timestampless gated host', () => {
        const { ability, service } = setupAbility('motion', true, {}, undefined, false);
        const motion = service.getCharacteristic(Characteristic.MotionDetected);

        ability.markDisconnected();
        expect(ability.observeStatus(true, null)).toBe(false);
        expect(ability.observeStatus(true, 'abc')).toBe(false);
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });
});
