import EventEmitter from 'eventemitter3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { Humidity } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { DeviceLogger } from '../utils/device-logger.ts';
import { ShellyPlatform } from '../platform.ts';
import { HumiditySensorAbility } from './humidity-sensor.ts';

function createHumidityComponent(initialRh: number | null = 48.2): Humidity {
    const emitter = new EventEmitter();
    const component = Object.assign(emitter, {
        id: 100,
        key: 'humidity:100',
        config: {},
        rh: initialRh,
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        emit: emitter.emit.bind(emitter),
    });

    return component as unknown as Humidity;
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

function setupAbility(component: Humidity): {
    ability: HumiditySensorAbility;
    characteristic: Characteristic;
} {
    const ability = new HumiditySensorAbility(component);
    const platform = createAbilityPlatform();
    const platformAccessory = {
        addService: (serviceClass: typeof Service.HumiditySensor, name?: string, subtype?: string) =>
            new serviceClass(name, subtype),
        getService: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;

    const log = new DeviceLogger({ id: 'shellyplus1pm-test' } as never, 'Test Device', platform.log);

    ability.setup(platformAccessory, platform, log);

    const characteristic = ability['service'].getCharacteristic(Characteristic.CurrentRelativeHumidity);

    return { ability, characteristic };
}

describe('HumiditySensorAbility', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('reports RESOURCE_BUSY when humidity is unavailable', () => {
        const { characteristic } = setupAbility(createHumidityComponent(null));

        expect(characteristic.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
    });

    it('updates HomeKit when change:rh fires', () => {
        const component = createHumidityComponent(40);
        const { ability, characteristic } = setupAbility(component);

        component.emit('change:rh', 56);
        expect(characteristic.value).toBe(56);

        ability.detach();
    });

    it('removes change:rh listener on detach', () => {
        const component = createHumidityComponent();
        const offSpy = vi.spyOn(component, 'off');
        const { ability } = setupAbility(component);

        ability.detach();

        expect(offSpy).toHaveBeenCalledWith('change:rh', expect.any(Function), ability);
    });
});
