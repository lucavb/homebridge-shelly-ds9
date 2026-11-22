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
});
