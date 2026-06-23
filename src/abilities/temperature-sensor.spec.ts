import EventEmitter from 'eventemitter3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { Temperature } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { DeviceLogger } from '../utils/device-logger.ts';
import { ShellyPlatform } from '../platform.ts';
import { TemperatureSensorAbility } from './temperature-sensor.ts';

function createTemperatureComponent(initialTc: number | null = 21.5): Temperature {
    const emitter = new EventEmitter();
    const component = Object.assign(emitter, {
        id: 100,
        key: 'temperature:100',
        config: {},
        tC: initialTc,
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        emit: emitter.emit.bind(emitter),
    });

    return component as unknown as Temperature;
}

function createAbilityPlatform(): ShellyPlatform {
    return {
        log: {
            log: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        api: {
            hap: {
                uuid,
                Characteristic,
                Service,
                HAPStatus,
                HapStatusError,
            },
        },
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
}

function setupAbility(component: Temperature): {
    ability: TemperatureSensorAbility;
    characteristic: Characteristic;
} {
    const ability = new TemperatureSensorAbility(component);
    const platform = createAbilityPlatform();
    const platformAccessory = {
        addService: (serviceClass: typeof Service.TemperatureSensor, name?: string, subtype?: string) =>
            new serviceClass(name, subtype),
        getService: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;

    const log = new DeviceLogger({ id: 'shellyplus1pm-test' } as never, 'Test Device', platform.log);

    ability.setup(platformAccessory, platform, log);

    const characteristic = ability['service'].getCharacteristic(Characteristic.CurrentTemperature);

    return { ability, characteristic };
}

describe('TemperatureSensorAbility', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('raises maxValue to 125°C for DS18B20 range', () => {
        const { characteristic } = setupAbility(createTemperatureComponent());

        expect(characteristic.props.maxValue).toBe(125);
    });

    it('reports RESOURCE_BUSY when temperature is unavailable', () => {
        const { characteristic } = setupAbility(createTemperatureComponent(null));

        expect(characteristic.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
    });

    it('clamps readings above 125°C', () => {
        const component = createTemperatureComponent(130);
        const { ability, characteristic } = setupAbility(component);

        expect(characteristic.value).toBe(125);

        component.emit('change:tC', 130);
        expect(characteristic.value).toBe(125);

        component.emit('change:tC', 110);
        expect(characteristic.value).toBe(110);

        ability.detach();
    });

    it('updates HomeKit when change:tC fires', () => {
        const component = createTemperatureComponent(20);
        const { ability, characteristic } = setupAbility(component);

        component.emit('change:tC', 24.6);
        expect(characteristic.value).toBeCloseTo(24.6, 5);

        ability.detach();
    });

    it('removes change:tC listener on detach', () => {
        const component = createTemperatureComponent();
        const offSpy = vi.spyOn(component, 'off');
        const { ability } = setupAbility(component);

        ability.detach();

        expect(offSpy).toHaveBeenCalledWith('change:tC', expect.any(Function), ability);
    });
});
