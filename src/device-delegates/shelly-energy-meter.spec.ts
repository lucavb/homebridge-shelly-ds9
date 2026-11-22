import EventEmitter from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shelly3EM63Gen3, ShellyPro3EM } from '@lucavb/shellies-ds9';
import { Characteristic, Formats, HAPStatus, HapStatusError, Perms, Service, uuid } from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';

import '../platform.ts';
import { DeviceDelegate } from './base.ts';
import { ShellyEnergyMeterDelegate } from './shelly-energy-meter.ts';
import { EnergyMeterAbility } from '../abilities/energy-meter.ts';
import { createCharacteristics } from '../utils/characteristics.ts';
import { createServices } from '../utils/services.ts';

/** Builds the shared custom characteristic/service classes used by meter abilities. */
function createCustomHap() {
    const api = { hap: { uuid, Characteristic, Formats, Perms, Service, HAPStatus, HapStatusError } } as unknown as API;
    const customCharacteristics = createCharacteristics(api);
    return { api, customCharacteristics, customServices: createServices(api, customCharacteristics) };
}

/** Drains pending promise continuations without letting macrotasks run. */
async function flushMicrotasks() {
    for (let i = 0; i < 25; i++) {
        await Promise.resolve();
    }
}

describe('Shelly energy meter delegate', () => {
    afterEach(() => vi.useRealTimers());

    it('registers the Pro 3EM and 3EM-63 Gen3 models', () => {
        expect(ShellyPro3EM.model).toBe('SPEM-003CEBEU');
        expect(Shelly3EM63Gen3.model).toBe('S3EM-003CXCEU63');
        expect(DeviceDelegate.getDelegate(ShellyPro3EM)).toBe(ShellyEnergyMeterDelegate);
        expect(DeviceDelegate.getDelegate(Shelly3EM63Gen3.model.toLowerCase())).toBe(ShellyEnergyMeterDelegate);
    });

    it('creates a relay accessory only when the optional switch component exists', () => {
        vi.useFakeTimers();
        const accessoriesFor = (withSwitch: boolean) => {
            const rpcHandler = Object.assign(new EventEmitter(), { connected: false });
            const device = Object.assign(new EventEmitter(), {
                id: 'shelly-energy-test',
                modelName: 'Shelly Pro 3EM',
                rpcHandler,
                meterProfile: undefined,
                switch0: withSwitch ? { id: 0, key: 'switch:0', config: {}, apower: undefined } : undefined,
                loadStatus: vi.fn().mockResolvedValue(undefined),
                *[Symbol.iterator]() {},
            });
            const platform = {
                log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                api: { hap: { uuid: { generate: (value: string) => value } } },
                getAccessory: () => undefined,
            };
            const delegate = new ShellyEnergyMeterDelegate(
                device as never,
                { name: 'Meter' } as never,
                platform as never,
            );
            const ids = [...delegate['accessories'].keys()];
            expect(rpcHandler.listenerCount('statusUpdate')).toBe(1);
            delegate.detach();
            expect(rpcHandler.listenerCount('statusUpdate')).toBe(0);
            return ids;
        };

        expect(accessoriesFor(false)).toEqual([]);
        expect(accessoriesFor(true)).toEqual(['switch-0']);
    });

    it('invalidates old readings and detaches old components after a live profile replacement', async () => {
        vi.useFakeTimers();
        const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
        const meter = Object.assign(new EventEmitter(), {
            id: 0,
            key: 'em:0',
            a_act_power: 12,
            a_current: 4,
            a_voltage: 230,
            b_act_power: 10,
            b_current: 4,
            b_voltage: 230,
            c_act_power: 8,
            c_current: 4,
            c_voltage: 230,
            total_act_power: 30,
            total_current: 12,
        });
        const components = new Map<string, object>([['em:0', meter]]);
        const device = Object.assign(new EventEmitter(), {
            id: 'shelly-energy-profile-test',
            modelName: 'Shelly Pro 3EM',
            rpcHandler,
            meterProfile: 'triphase',
            em: meter,
            emdata: undefined,
            switch0: undefined,
            getComponent: (key: string) => components.get(key),
            *[Symbol.iterator]() {
                yield* components.entries();
            },
        });
        const logger = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const { api, customCharacteristics, customServices } = createCustomHap();
        const platform = {
            log: logger,
            api,
            customCharacteristics,
            customServices,
            getAccessory: vi.fn(() => undefined),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        };
        const delegate = new ShellyEnergyMeterDelegate(device as never, { name: 'Meter' } as never, platform as never);
        const ability = delegate['accessories']
            .get('energy-meter')!
            .abilities.find((candidate): candidate is EnergyMeterAbility => candidate instanceof EnergyMeterAbility)!;
        const services: Service[] = [];
        const platformAccessory = {
            services,
            addService: (serviceClass: typeof Service, name?: string, subtype?: string) => {
                const service = new serviceClass(name, subtype);
                services.push(service);
                return service;
            },
            getService: (serviceClassOrName: typeof Service | string) =>
                services.find((service) =>
                    typeof serviceClassOrName === 'string'
                        ? service.displayName === serviceClassOrName
                        : service.UUID === serviceClassOrName.UUID,
                ),
            getServiceById: (serviceClass: typeof Service, subtype: string) =>
                services.find((service) => service.UUID === serviceClass.UUID && service.subtype === subtype),
            removeService: (service: Service) => services.splice(services.indexOf(service), 1),
        } as unknown as PlatformAccessory;
        ability.setup(platformAccessory, platform as never, delegate.log);
        const primaryPower = ability['service'].getCharacteristic(ability['customCharacteristics'].SignedNetPower);
        const phaseA = ability['phaseServices'].get('a')!;
        const phasePower = phaseA.getCharacteristic(ability['customCharacteristics'].SignedNetPower);
        const updateValue = vi.spyOn(primaryPower, 'updateValue');
        expect(primaryPower.value).toBe(30);
        expect(phasePower.value).toBe(12);
        expect(meter.listenerCount('change:a_act_power')).toBe(1);

        const replacement = Object.assign(new EventEmitter(), { id: 0, key: 'em:0', total_act_power: 0 });
        components.set('em:0', replacement);
        rpcHandler.emit('statusUpdate', {});

        expect(primaryPower.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(updateValue).toHaveBeenCalledWith(expect.objectContaining({ hapStatus: HAPStatus.RESOURCE_BUSY }));
        await expect(primaryPower.handleGetRequest()).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        expect(phasePower.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(meter.listenerCount('change:a_act_power')).toBe(0);
        expect(rpcHandler.listenerCount('statusUpdate')).toBe(0);
        expect(logger.log).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('Energy-meter profile changed; readings are unavailable until Homebridge restarts'),
        );

        delegate.detach();
    });

    it('removes only this device cached switch after a successful complete status confirms absence', async () => {
        const createDelegate = (
            call: () => Promise<Record<string, unknown>>,
            connected = true,
            cachedDeviceId = 'shelly-energy-cleanup',
        ) => {
            const rpcHandler = Object.assign(new EventEmitter(), { connected });
            const device = Object.assign(new EventEmitter(), {
                id: 'shelly-energy-cleanup',
                model: ShellyPro3EM.model,
                modelName: 'Shelly Pro 3EM',
                rpcHandler,
                meterProfile: 'triphase',
                switch0: undefined,
                call,
                *[Symbol.iterator]() {},
            });
            const cachedAccessory = {
                UUID: 'shelly-energy-cleanup-switch-0',
                context: { device: { id: cachedDeviceId } },
            };
            const platform = {
                log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                api: { hap: { uuid: { generate: (value: string) => value } } },
                getAccessory: vi.fn((uuid: string) =>
                    uuid === cachedAccessory.UUID ? (cachedAccessory as never) : undefined,
                ),
                removeAccessory: vi.fn(),
            };
            const delegate = new ShellyEnergyMeterDelegate(
                device as never,
                { name: 'Meter' } as never,
                platform as never,
            );
            return { delegate, platform, cachedAccessory, device };
        };

        const statusConfirmedAbsent = createDelegate(async () => ({ 'em:0': {}, 'emdata:0': {} }));
        await Promise.resolve();
        await Promise.resolve();
        expect(statusConfirmedAbsent.platform.removeAccessory).toHaveBeenCalledWith(
            statusConfirmedAbsent.cachedAccessory,
        );
        statusConfirmedAbsent.delegate.detach();

        const unknownStatus = createDelegate(async () => {
            throw new Error('RPC unavailable');
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(unknownStatus.platform.removeAccessory).not.toHaveBeenCalled();
        unknownStatus.delegate.detach();

        const incompleteStatus = createDelegate(async () => ({ 'em:0': {} }));
        await Promise.resolve();
        await Promise.resolve();
        expect(incompleteStatus.platform.removeAccessory).not.toHaveBeenCalled();
        incompleteStatus.delegate.detach();

        const foreignCachedAccessory = createDelegate(async () => undefined, true, 'some-other-device');
        await Promise.resolve();
        await Promise.resolve();
        expect(foreignCachedAccessory.platform.removeAccessory).not.toHaveBeenCalled();
        foreignCachedAccessory.delegate.detach();

        const disconnected = createDelegate(vi.fn(), false);
        expect(disconnected.device.call).not.toHaveBeenCalled();
        expect(disconnected.platform.removeAccessory).not.toHaveBeenCalled();
        disconnected.delegate.detach();
    });

    it('binds a cached relay immediately when switch0 is already present despite a failing RPC', () => {
        vi.useFakeTimers();
        const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
        const device = Object.assign(new EventEmitter(), {
            id: 'shelly-energy-cached-present',
            model: ShellyPro3EM.model,
            modelName: 'Shelly Pro 3EM',
            rpcHandler,
            meterProfile: undefined,
            switch0: { id: 0, key: 'switch:0', config: {}, apower: undefined },
            call: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
            *[Symbol.iterator]() {},
        });
        const cachedAccessory = {
            UUID: `${device.id}-switch-0`,
            context: { device: { id: device.id } },
        };
        const platform = {
            log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
            api: { hap: { uuid: { generate: (value: string) => value } } },
            getAccessory: vi.fn(() => cachedAccessory),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        };

        const delegate = new ShellyEnergyMeterDelegate(device as never, { name: 'Meter' } as never, platform as never);

        expect([...delegate['accessories'].keys()]).toEqual(['switch-0']);
        expect(platform.getAccessory).toHaveBeenCalledWith(`${device.id}-switch-0`);
        expect(device.call).not.toHaveBeenCalled();
        expect(platform.removeAccessory).not.toHaveBeenCalled();
        delegate.detach();
    });

    it('does not add or remove a cached relay when detached during either status request', async () => {
        const createInFlightDelegate = () => {
            let resolveGetStatus!: (value: Record<string, unknown>) => void;
            let resolveLoadStatus!: () => void;
            const call = vi.fn(
                () =>
                    new Promise<Record<string, unknown>>((resolve) => {
                        resolveGetStatus = resolve;
                    }),
            );
            const loadStatus = vi.fn(
                () =>
                    new Promise<void>((resolve) => {
                        resolveLoadStatus = resolve;
                    }),
            );
            const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
            const device = Object.assign(new EventEmitter(), {
                id: 'shelly-energy-detach-flight',
                model: ShellyPro3EM.model,
                modelName: 'Shelly Pro 3EM',
                rpcHandler,
                meterProfile: 'triphase',
                em: { key: 'em:0' },
                emdata: { key: 'emdata:0' },
                switch0: undefined,
                call,
                loadStatus,
                *[Symbol.iterator]() {},
            });
            const cachedAccessory = {
                UUID: `${device.id}-switch-0`,
                context: { device: { id: device.id } },
            };
            const platform = {
                log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                api: { hap: { uuid: { generate: (value: string) => value } } },
                getAccessory: vi.fn(() => cachedAccessory),
                addAccessory: vi.fn(),
                removeAccessory: vi.fn(),
            };
            const delegate = new ShellyEnergyMeterDelegate(
                device as never,
                { name: 'Meter' } as never,
                platform as never,
            );
            return {
                delegate,
                platform,
                device,
                call,
                loadStatus,
                resolveGetStatus: (value: Record<string, unknown>) => resolveGetStatus(value),
                resolveLoadStatus: () => resolveLoadStatus(),
            };
        };

        const duringGetStatus = createInFlightDelegate();
        duringGetStatus.delegate.detach();
        duringGetStatus.resolveGetStatus({ 'em:0': {}, 'emdata:0': {} });
        await Promise.resolve();
        await Promise.resolve();
        expect(duringGetStatus.platform.removeAccessory).not.toHaveBeenCalled();
        expect(duringGetStatus.delegate['accessories'].has('switch-0')).toBe(false);

        const duringLoadStatus = createInFlightDelegate();
        duringLoadStatus.resolveGetStatus({ 'em:0': {}, 'emdata:0': {}, 'switch:0': {} });
        await Promise.resolve();
        await Promise.resolve();
        expect(duringLoadStatus.loadStatus).toHaveBeenCalledOnce();
        duringLoadStatus.delegate.detach();
        duringLoadStatus.device.switch0 = { id: 0, key: 'switch:0', config: {}, apower: undefined };
        duringLoadStatus.resolveLoadStatus();
        await Promise.resolve();
        await Promise.resolve();
        expect(duringLoadStatus.platform.addAccessory).not.toHaveBeenCalled();
        expect(duringLoadStatus.platform.removeAccessory).not.toHaveBeenCalled();
        expect(duringLoadStatus.delegate['accessories'].has('switch-0')).toBe(false);
    });

    it('binds a cached relay when a complete status confirms switch:0 and loadStatus seeds it', async () => {
        const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
        const switch0 = { id: 0, key: 'switch:0', config: {}, apower: undefined };
        const device: EventEmitter & { switch0?: typeof switch0 } = Object.assign(new EventEmitter(), {
            id: 'shelly-energy-rebind',
            model: ShellyPro3EM.model,
            modelName: 'Shelly Pro 3EM',
            rpcHandler,
            meterProfile: 'triphase',
            em: { key: 'em:0' },
            emdata: { key: 'emdata:0' },
            switch0: undefined,
            call: vi.fn().mockResolvedValue({ 'em:0': {}, 'emdata:0': {}, 'switch:0': { id: 0 } }),
            loadStatus: vi.fn(async () => {
                device.switch0 = switch0;
            }),
            *[Symbol.iterator]() {},
        });
        const cachedAccessory = {
            UUID: `${device.id}-switch-0`,
            context: { device: { id: device.id } },
        };
        const platform = {
            log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
            api: { hap: { uuid: { generate: (value: string) => value } } },
            getAccessory: vi.fn((uuid: string) => (uuid === cachedAccessory.UUID ? cachedAccessory : undefined)),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        };

        const delegate = new ShellyEnergyMeterDelegate(device as never, { name: 'Meter' } as never, platform as never);
        await flushMicrotasks();

        expect(platform.getAccessory).toHaveBeenCalledWith(`${device.id}-switch-0`);
        expect(device.loadStatus).toHaveBeenCalledOnce();
        expect(delegate['accessories'].has('switch-0')).toBe(true);
        expect(platform.removeAccessory).not.toHaveBeenCalled();
        delegate.detach();
    });

    it('reconciles a monophase cached relay from complete em1 status and retains it when incomplete', async () => {
        const createFixture = (complete: boolean) => {
            const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
            const switch0 = { id: 0, key: 'switch:0', config: {}, apower: undefined };
            const status: Record<string, unknown> = {
                'em1:0': {},
                'em1:1': {},
                'em1:2': {},
                'em1data:0': {},
                'em1data:1': {},
            };
            if (complete) {
                status['em1data:2'] = {};
                status['switch:0'] = { id: 0 };
            }
            const device: EventEmitter & { switch0?: typeof switch0 } = Object.assign(new EventEmitter(), {
                id: 'shelly-energy-mono-reconcile',
                model: ShellyPro3EM.model,
                modelName: 'Shelly Pro 3EM',
                rpcHandler,
                meterProfile: 'monophase',
                em1: [{ key: 'em1:0' }, { key: 'em1:1' }, { key: 'em1:2' }],
                em1data: [{ key: 'em1data:0' }, { key: 'em1data:1' }, { key: 'em1data:2' }],
                switch0: undefined,
                call: vi.fn().mockResolvedValue(status),
                loadStatus: vi.fn(async () => {
                    device.switch0 = switch0;
                }),
                *[Symbol.iterator]() {},
            });
            const cachedAccessory = {
                UUID: `${device.id}-switch-0`,
                context: { device: { id: device.id } },
            };
            const platform = {
                log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
                api: { hap: { uuid: { generate: (value: string) => value } } },
                getAccessory: vi.fn((uuid: string) => (uuid === cachedAccessory.UUID ? cachedAccessory : undefined)),
                addAccessory: vi.fn(),
                removeAccessory: vi.fn(),
            };
            const delegate = new ShellyEnergyMeterDelegate(
                device as never,
                { name: 'Meter' } as never,
                platform as never,
            );
            return { delegate, platform, device };
        };

        const complete = createFixture(true);
        await flushMicrotasks();
        expect(complete.device.loadStatus).toHaveBeenCalledOnce();
        expect(complete.delegate['accessories'].has('switch-0')).toBe(true);
        expect(complete.platform.removeAccessory).not.toHaveBeenCalled();
        complete.delegate.detach();

        const incomplete = createFixture(false);
        await flushMicrotasks();
        expect(incomplete.device.loadStatus).not.toHaveBeenCalled();
        expect(incomplete.delegate['accessories'].has('switch-0')).toBe(false);
        expect(incomplete.platform.removeAccessory).not.toHaveBeenCalled();
        incomplete.delegate.detach();
    });

    it('skips relay reconciliation work when complete status confirms an already bound relay', async () => {
        let resolveGetStatus!: (value: Record<string, unknown>) => void;
        const call = vi.fn(
            () =>
                new Promise<Record<string, unknown>>((resolve) => {
                    resolveGetStatus = resolve;
                }),
        );
        const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
        const device = Object.assign(new EventEmitter(), {
            id: 'shelly-energy-short-circuit',
            model: ShellyPro3EM.model,
            modelName: 'Shelly Pro 3EM',
            rpcHandler,
            meterProfile: 'triphase',
            em: { key: 'em:0' },
            emdata: { key: 'emdata:0' },
            switch0: undefined,
            call,
            loadStatus: vi.fn().mockResolvedValue(undefined),
            *[Symbol.iterator]() {},
        });
        const cachedAccessory = {
            UUID: `${device.id}-switch-0`,
            context: { device: { id: device.id } },
        };
        const platform = {
            log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
            api: { hap: { uuid: { generate: (value: string) => value } } },
            getAccessory: vi.fn((uuid: string) => (uuid === cachedAccessory.UUID ? cachedAccessory : undefined)),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        };

        const delegate = new ShellyEnergyMeterDelegate(device as never, { name: 'Meter' } as never, platform as never);

        // Simulate the relay being bound while the full-status request is in flight.
        delegate['addSwitch']({ id: 0, key: 'switch:0', config: {}, apower: undefined } as never);

        resolveGetStatus({ 'em:0': {}, 'emdata:0': {}, 'switch:0': { id: 0 } });
        await flushMicrotasks();

        expect(delegate['accessories'].has('switch-0')).toBe(true);
        expect(device.loadStatus).not.toHaveBeenCalled();
        expect(platform.addAccessory).not.toHaveBeenCalled();
        expect(platform.removeAccessory).not.toHaveBeenCalled();
        delegate.detach();
    });

    it('keeps readings live and the listener registered when a routine statusUpdate reports unchanged components', async () => {
        vi.useFakeTimers();
        const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
        const meter = Object.assign(new EventEmitter(), {
            id: 0,
            key: 'em:0',
            a_act_power: 12,
            a_current: 4,
            a_voltage: 230,
            b_act_power: 10,
            b_current: 4,
            b_voltage: 230,
            c_act_power: 8,
            c_current: 4,
            c_voltage: 230,
            total_act_power: 30,
            total_current: 12,
        });
        const components = new Map<string, object>([['em:0', meter]]);
        const device = Object.assign(new EventEmitter(), {
            id: 'shelly-energy-routine-update',
            modelName: 'Shelly Pro 3EM',
            rpcHandler,
            meterProfile: 'triphase',
            em: meter,
            emdata: undefined,
            switch0: undefined,
            getComponent: (key: string) => components.get(key),
            *[Symbol.iterator]() {
                yield* components.entries();
            },
        });
        const logger = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const { api, customCharacteristics, customServices } = createCustomHap();
        const platform = {
            log: logger,
            api,
            customCharacteristics,
            customServices,
            getAccessory: vi.fn(() => undefined),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        };
        const delegate = new ShellyEnergyMeterDelegate(device as never, { name: 'Meter' } as never, platform as never);
        const ability = delegate['accessories']
            .get('energy-meter')!
            .abilities.find((candidate): candidate is EnergyMeterAbility => candidate instanceof EnergyMeterAbility)!;
        const services: Service[] = [];
        const platformAccessory = {
            services,
            addService: (serviceClass: typeof Service, name?: string, subtype?: string) => {
                const service = new serviceClass(name, subtype);
                services.push(service);
                return service;
            },
            getService: (serviceClassOrName: typeof Service | string) =>
                services.find((service) =>
                    typeof serviceClassOrName === 'string'
                        ? service.displayName === serviceClassOrName
                        : service.UUID === serviceClassOrName.UUID,
                ),
            getServiceById: (serviceClass: typeof Service, subtype: string) =>
                services.find((service) => service.UUID === serviceClass.UUID && service.subtype === subtype),
            removeService: (service: Service) => services.splice(services.indexOf(service), 1),
        } as unknown as PlatformAccessory;
        ability.setup(platformAccessory, platform as never, delegate.log);
        const primaryPower = ability['service'].getCharacteristic(ability['customCharacteristics'].SignedNetPower);
        expect(primaryPower.value).toBe(30);
        expect(meter.listenerCount('change:a_act_power')).toBe(1);
        expect(rpcHandler.listenerCount('statusUpdate')).toBe(1);

        // A routine notification naming components that were not replaced.
        rpcHandler.emit('statusUpdate', {});

        expect(rpcHandler.listenerCount('statusUpdate')).toBe(1);
        expect(meter.listenerCount('change:a_act_power')).toBe(1);
        await expect(primaryPower.handleGetRequest()).resolves.toBe(30);
        expect(logger.log).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('Energy-meter profile changed; readings are unavailable until Homebridge restarts'),
        );

        delegate.detach();
        expect(rpcHandler.listenerCount('statusUpdate')).toBe(0);
    });

    it('keeps and adopts a relay constructed by a status notification during an in-flight full-status request', async () => {
        let resolveGetStatus!: (value: Record<string, unknown>) => void;
        const call = vi.fn(
            () =>
                new Promise<Record<string, unknown>>((resolve) => {
                    resolveGetStatus = resolve;
                }),
        );
        const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
        const switch0 = { id: 0, key: 'switch:0', config: {}, apower: undefined };
        const components = new Map<string, object>([
            ['em:0', { id: 0, key: 'em:0' }],
            ['emdata:0', { id: 0, key: 'emdata:0' }],
        ]);
        const device: EventEmitter & { switch0?: typeof switch0 } = Object.assign(new EventEmitter(), {
            id: 'shelly-energy-inflight-relay',
            model: ShellyPro3EM.model,
            modelName: 'Shelly Pro 3EM',
            rpcHandler,
            meterProfile: 'triphase',
            em: components.get('em:0'),
            emdata: components.get('emdata:0'),
            switch0: undefined,
            call,
            loadStatus: vi.fn().mockResolvedValue(undefined),
            getComponent: (key: string) => components.get(key),
            *[Symbol.iterator]() {
                yield* components.entries();
            },
        });
        const cachedAccessory = {
            UUID: `${device.id}-switch-0`,
            context: { device: { id: device.id } },
        };
        const platform = {
            log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
            api: { hap: { uuid: { generate: (value: string) => value } } },
            getAccessory: vi.fn((uuid: string) => (uuid === cachedAccessory.UUID ? cachedAccessory : undefined)),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        };

        const delegate = new ShellyEnergyMeterDelegate(device as never, { name: 'Meter' } as never, platform as never);

        // While the full-status request is in flight, a status notification
        // constructs and adopts the relay.
        device.switch0 = switch0;
        rpcHandler.emit('statusUpdate', {});
        expect(delegate['accessories'].has('switch-0')).toBe(true);

        // The response is a complete meter inventory that omits switch:0 —
        // it can never prove the adopted relay is absent.
        resolveGetStatus({ 'em:0': {}, 'emdata:0': {} });
        await flushMicrotasks();

        expect(delegate['accessories'].has('switch-0')).toBe(true);
        expect(platform.removeAccessory).not.toHaveBeenCalled();
        expect(platform.log.log).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('Removed cached optional relay accessory'),
        );
        delegate.detach();
    });

    it('swallows a failing loadStatus after complete status confirms switch:0 and keeps the relay unbound', async () => {
        const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
        const device: EventEmitter & { switch0?: unknown } = Object.assign(new EventEmitter(), {
            id: 'shelly-energy-loadstatus-fails',
            model: ShellyPro3EM.model,
            modelName: 'Shelly Pro 3EM',
            rpcHandler,
            meterProfile: 'triphase',
            em: { key: 'em:0' },
            emdata: { key: 'emdata:0' },
            switch0: undefined,
            call: vi.fn().mockResolvedValue({ 'em:0': {}, 'emdata:0': {}, 'switch:0': { id: 0 } }),
            loadStatus: vi.fn().mockRejectedValue(new Error('loadStatus failed')),
            *[Symbol.iterator]() {},
        });
        const cachedAccessory = {
            UUID: `${device.id}-switch-0`,
            context: { device: { id: device.id } },
        };
        const platform = {
            log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
            api: { hap: { uuid: { generate: (value: string) => value } } },
            getAccessory: vi.fn((uuid: string) => (uuid === cachedAccessory.UUID ? cachedAccessory : undefined)),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        };

        const delegate = new ShellyEnergyMeterDelegate(device as never, { name: 'Meter' } as never, platform as never);
        await flushMicrotasks();

        expect(device.loadStatus).toHaveBeenCalledOnce();
        expect(delegate['accessories'].has('switch-0')).toBe(false);
        expect(platform.addAccessory).not.toHaveBeenCalled();
        expect(platform.removeAccessory).not.toHaveBeenCalled();
        expect(platform.log.log).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('Could not initialize confirmed optional relay component'),
        );
        delegate.detach();
    });
});
