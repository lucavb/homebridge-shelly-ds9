import EventEmitter from 'eventemitter3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, Formats, HAPStatus, HapStatusError, Perms, Service, uuid } from '@homebridge/hap-nodejs';
import type { EM, EM1, EM1Data, EMData } from '@lucavb/shellies-ds9';
import type { API, PlatformAccessory } from 'homebridge';

import { DeviceLogger } from '../utils/device-logger.ts';
import { createCharacteristics } from '../utils/characteristics.ts';
import { createServices } from '../utils/services.ts';
import { ShellyPlatform } from '../platform.ts';
import { EnergyMeterAbility } from './energy-meter.ts';

function component<T extends object>(initial: T): T & EventEmitter {
    return Object.assign(new EventEmitter(), initial);
}

const CHARACTERISTIC_NAMES = {
    power: 'SignedNetPower',
    consumption: 'CurrentConsumption',
    current: 'ElectricCurrent',
    voltage: 'Voltage',
    imported: 'TotalConsumption',
    exported: 'ExportedEnergy',
} as const;

function setupAbility(ability: EnergyMeterAbility, services: Service[] = []) {
    const api = { hap: { uuid, Characteristic, Formats, Perms, Service, HAPStatus, HapStatusError } } as unknown as API;
    const customCharacteristics = createCharacteristics(api);
    const platform = {
        log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        api,
        customCharacteristics,
        customServices: createServices(api, customCharacteristics),
    } as unknown as ShellyPlatform;
    const accessory = {
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
    const log = new DeviceLogger({ id: 'shelly-energy-test' } as never, 'Test Meter', platform.log);
    ability.setup(accessory, platform, log);
    return { ability, services };
}

function char(
    ability: EnergyMeterAbility,
    key: 'power' | 'consumption' | 'current' | 'voltage' | 'imported' | 'exported',
) {
    return ability['service'].getCharacteristic(ability['customCharacteristics'][CHARACTERISTIC_NAMES[key]]);
}

describe('EnergyMeterAbility', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('updates triphase phase and aggregate values while preserving signed power and Wh units', () => {
        const meter = component({
            a_act_power: 20,
            a_current: 63,
            a_voltage: 230,
            b_act_power: -8,
            b_current: 12,
            b_voltage: 231,
            c_act_power: 2,
            c_current: 14,
            c_voltage: 229,
            total_act_power: 14,
            total_current: 89,
        }) as unknown as EM;
        const data = component({
            a_total_act_energy: 12000,
            a_total_act_ret_energy: 500,
            b_total_act_energy: 1000,
            b_total_act_ret_energy: 2000,
            c_total_act_energy: 3000,
            c_total_act_ret_energy: 4000,
            total_act: 16000,
            total_act_ret: 6500,
        }) as unknown as EMData;
        const ability = new EnergyMeterAbility('triphase', { meter, data });
        setupAbility(ability);

        expect(ability['service'].UUID).toBe('A6F2EAB1-2D4A-4E2B-9AC3-6A7E611CA001');
        expect(ability['customServices'].ThreePhaseMeter.UUID).toBe('A6F2EAB1-2D4A-4E2B-9AC3-6A7E611CA001');
        expect(char(ability, 'power').value).toBe(14);
        expect(char(ability, 'power').statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        expect(char(ability, 'consumption').value).toBe(14);
        expect(char(ability, 'imported').value).toBe(16);
        expect(char(ability, 'exported').value).toBe(6.5);
        expect(char(ability, 'current').value).toBe(89);
        expect(char(ability, 'current').props.maxValue).toBe(1000);
        const phaseA = ability['phaseServices'].get('a')!;
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].SignedNetPower).value).toBe(20);
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].ElectricCurrent).value).toBe(63);
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].TotalConsumption).value).toBe(12);
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].CurrentConsumption).value).toBe(20);
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].CurrentConsumption).UUID).toBe(
            'E863F10D-079E-48FF-8F27-9C2605A29F52',
        );
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].TotalConsumption).UUID).toBe(
            'E863F10C-079E-48FF-8F27-9C2605A29F52',
        );
        const phaseB = ability['phaseServices'].get('b')!;
        expect(phaseB.getCharacteristic(ability['customCharacteristics'].SignedNetPower).value).toBe(-8);
        expect(phaseB.getCharacteristic(ability['customCharacteristics'].CurrentConsumption).value).toBe(0);
        expect(phaseB.getCharacteristic(ability['customCharacteristics'].ExportedEnergy).value).toBe(2);

        meter.total_act_power = -4;
        (meter as unknown as { total_current: number }).total_current = 99;
        meter.b_act_power = -20;
        meter.emit('change:total_current', 99);
        meter.emit('change:b_act_power', -20);
        expect(char(ability, 'power').value).toBe(-4);
        expect(char(ability, 'consumption').value).toBe(0);
        expect(char(ability, 'current').value).toBe(99);
        expect(
            ability['phaseServices'].get('b')!.getCharacteristic(ability['customCharacteristics'].SignedNetPower).value,
        ).toBe(-20);
        ability.detach();
    });

    it('does not seed absent/null readings as zero or publish a partial monophase aggregate', () => {
        const meters = [0, 1, 2].map(() =>
            component({ act_power: null, current: undefined, voltage: null }),
        ) as unknown as [EM1, EM1, EM1];
        const counters = [
            component({ total_act_energy: 1000, total_act_ret_energy: 200 }),
            component({ total_act_energy: null, total_act_ret_energy: 300 }),
            component({ total_act_energy: 4000, total_act_ret_energy: 500 }),
        ] as unknown as [EM1Data, EM1Data, EM1Data];
        const ability = new EnergyMeterAbility('monophase', [
            { meter: meters[0], data: counters[0] },
            { meter: meters[1], data: counters[1] },
            { meter: meters[2], data: counters[2] },
        ]);
        setupAbility(ability);

        expect(char(ability, 'power').statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(char(ability, 'imported').statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(char(ability, 'exported').value).toBe(1);

        meters[0].act_power = 10;
        meters[1].act_power = -3;
        meters[2].act_power = 5;
        meters[0].emit('change:act_power', 10);
        meters[1].emit('change:act_power', -3);
        meters[2].emit('change:act_power', 5);
        expect(char(ability, 'power').value).toBe(12);
        expect(char(ability, 'power').statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);

        meters[0].act_power = null;
        meters[0].emit('change:act_power', null);
        expect(char(ability, 'power').statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        counters[1].total_act_energy = 2000;
        counters[1].emit('change:total_act_energy', 2000);
        expect(char(ability, 'imported').value).toBe(7);
        ability.detach();
    });

    it('removes all bound listeners on detach', () => {
        const meter = component({ a_act_power: 1, total_act_power: 1 }) as unknown as EM;
        const offSpy = vi.spyOn(meter, 'off');
        const ability = new EnergyMeterAbility('triphase', { meter });
        setupAbility(ability);
        ability.detach();
        expect(offSpy).toHaveBeenCalledWith('change:a_act_power', ability['componentChangeHandler'], ability);
        expect(meter.listenerCount('change:a_act_power')).toBe(0);
    });

    it('reuses cached phase services by ID and restores safe characteristic ranges', () => {
        const meter = component({
            a_act_power: 10,
            a_current: 63,
            total_act_power: 10,
            total_current: 63,
        }) as unknown as EM;
        const source = { meter };
        const first = new EnergyMeterAbility('triphase', source);
        const { services } = setupAbility(first);
        const cachedPhaseA = first['phaseServices'].get('a')!;
        cachedPhaseA
            .getCharacteristic(first['customCharacteristics'].ElectricCurrent)
            .setProps({ minValue: 0, maxValue: 48 });
        first.detach();

        const second = new EnergyMeterAbility('triphase', source);
        setupAbility(second, services);

        expect(second['phaseServices'].get('a')).toBe(cachedPhaseA);
        expect(services).toHaveLength(4);
        expect(char(second, 'current').props.maxValue).toBe(1000);
        expect(cachedPhaseA.getCharacteristic(second['customCharacteristics'].ElectricCurrent).props.maxValue).toBe(
            1000,
        );
        second.detach();
    });

    it('marks out-of-range and infinite measurements unavailable', () => {
        const meter = component({
            a_act_power: 10,
            a_current: 63,
            total_act_power: 10,
            total_current: 63,
        }) as unknown as EM;
        const ability = new EnergyMeterAbility('triphase', { meter });
        setupAbility(ability);
        const phaseA = ability['phaseServices'].get('a')!;

        meter.a_current = 1001;
        meter.emit('change:a_current', 1001);
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].ElectricCurrent).statusCode).toBe(
            HAPStatus.RESOURCE_BUSY,
        );
        meter.a_act_power = Number.POSITIVE_INFINITY;
        meter.emit('change:a_act_power', Number.POSITIVE_INFINITY);
        expect(phaseA.getCharacteristic(ability['customCharacteristics'].SignedNetPower).statusCode).toBe(
            HAPStatus.RESOURCE_BUSY,
        );
        ability.detach();
    });

    it('transitions from an HAP unavailable error to a subscribed value update', () => {
        const meter = component({
            a_act_power: null,
            a_current: 1,
            a_voltage: 230,
            total_act_power: null,
            total_current: 1,
        }) as unknown as EM;
        const ability = new EnergyMeterAbility('triphase', { meter });
        setupAbility(ability);
        const phaseA = ability['phaseServices'].get('a')!;
        const signedPower = phaseA.getCharacteristic(ability['customCharacteristics'].SignedNetPower);
        const updateValue = vi.spyOn(signedPower, 'updateValue');
        const notification = vi.fn();
        signedPower.on('change', notification);

        meter.emit('change:a_act_power', null);
        expect(signedPower.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(updateValue).toHaveBeenCalledWith(expect.objectContaining({ hapStatus: HAPStatus.RESOURCE_BUSY }));

        meter.a_act_power = 7;
        meter.emit('change:a_act_power', 7);

        expect(signedPower.statusCode).toBe(HAPStatus.SUCCESS);
        expect(signedPower.value).toBe(7);
        expect(notification).toHaveBeenCalledWith(expect.objectContaining({ newValue: 7, reason: 'update' }));
        ability.detach();
    });
});
