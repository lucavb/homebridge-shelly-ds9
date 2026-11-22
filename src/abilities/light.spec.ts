import EventEmitter from 'eventemitter3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { Light } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { ShellyPlatform } from '../platform.ts';
import { DeviceLogger } from '../utils/device-logger.ts';
import { LightAbility } from './light.ts';

function createLightComponent(brightness: number | undefined, output: boolean | undefined = true): Light {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
        id: 0,
        key: 'light:0',
        config: {},
        output,
        brightness,
        set: vi.fn().mockResolvedValue(null),
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        emit: emitter.emit.bind(emitter),
    }) as unknown as Light;
}

function setupAbility(component: LightAbility['component']) {
    const ability = new LightAbility(component);
    const platform = {
        log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        api: { hap: { uuid, Characteristic, Service, HAPStatus, HapStatusError } },
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
    const platformAccessory = {
        addService: (serviceClass: typeof Service.Lightbulb, name?: string, subtype?: string) =>
            new serviceClass(name, subtype),
        getService: () => undefined,
        getServiceById: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;
    const log = new DeviceLogger({ id: 'shelly-plus-rgbw-pm-test' } as never, 'Test Device', platform.log);
    ability.setup(platformAccessory, platform, log);

    return { ability, service: ability['service'] };
}

describe('LightAbility', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('seeds the initial HomeKit Brightness from the already-loaded light status', () => {
        const { ability, service } = setupAbility(createLightComponent(37));

        expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(37);
        ability.detach();
    });

    it('leaves the HomeKit brightness default intact when brightness is not reported', () => {
        const component = createLightComponent(undefined);
        const { ability, service } = setupAbility(component);
        const brightness = service.getCharacteristic(Characteristic.Brightness);

        // HAP's default is 0; fabricated seeding (e.g. `?? 100`) must fail here.
        expect(brightness.value).toBe(0);
        component.emit('change:brightness', undefined);
        expect(brightness.value).toBe(0);
        ability.detach();
    });

    it('leaves the HomeKit brightness default intact when brightness is not finite', () => {
        const component = createLightComponent(Number.NaN);
        const { ability, service } = setupAbility(component);

        expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(0);
        ability.detach();
    });

    it('leaves the HomeKit On default intact when output is not reported', () => {
        // explicit `undefined` would trigger the factory default, so assign after construction
        const component = Object.assign(createLightComponent(undefined), { output: undefined });
        const { ability, service } = setupAbility(component);

        // HAP's default is false; seeding a fabricated On value must fail here.
        expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
        ability.detach();
    });

    it('drops non-boolean output change events', () => {
        const component = createLightComponent(undefined);
        const { ability, service } = setupAbility(component);
        const on = service.getCharacteristic(Characteristic.On);
        const updateValue = vi.spyOn(on, 'updateValue');

        component.emit('change:output', 'garbage');

        expect(on.value).toBe(true);
        expect(updateValue).not.toHaveBeenCalled();
        ability.detach();
    });

    it('accepts valid brightness updates after setup', () => {
        const component = createLightComponent(undefined);
        const { ability, service } = setupAbility(component);
        const brightness = service.getCharacteristic(Characteristic.Brightness);

        component.emit('change:brightness', 62);

        expect(brightness.value).toBe(62);
        ability.detach();
    });
});
