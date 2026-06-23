import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Categories } from 'homebridge';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import { Humidity, RpcHandler, ShellyPlus1Pm, Temperature } from '@lucavb/shellies-ds9';

import { HumiditySensorAbility, TemperatureSensorAbility } from '../abilities/index.ts';
import { resolveAccessoryCategory } from '../accessory.ts';
import { DeviceOptions } from '../config.ts';
import { ShellyPlus1Delegate } from './shelly-plus-1.ts';
import { DeviceDelegate } from './base.ts';
import { ShellyPlatform } from '../platform.ts';
import { ADDON_SENSOR_STATUS } from '../fixtures/addon-sensors.ts';

class TestRpcHandler extends RpcHandler {
    constructor() {
        super('test');
    }

    connected = true;
    request = vi.fn().mockResolvedValue({});
    destroy = vi.fn().mockResolvedValue(undefined);
}

class MockPlatformAccessory {
    context: Record<string, unknown> = {};
    private readonly services = new Map<string, Service>();

    constructor(
        readonly displayName: string,
        readonly uuid: string,
        readonly category: Categories,
    ) {}

    addService(serviceClass: typeof Service, name?: string, subtype?: string): Service {
        const service = new serviceClass(name, subtype);
        if (name) {
            this.services.set(name, service);
        }
        if (subtype) {
            this.services.set(subtype, service);
        }
        return service;
    }

    getService(nameOrClass: string | typeof Service): Service | undefined {
        if (typeof nameOrClass === 'string') {
            return this.services.get(nameOrClass);
        }
        return [...this.services.values()].find((service) => service.UUID === nameOrClass.UUID);
    }

    removeService = vi.fn();
}

function createMockPlatform(): ShellyPlatform {
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
            platformAccessory: MockPlatformAccessory,
        },
        getAccessory: vi.fn().mockReturnValue(null),
        addAccessory: vi.fn(),
        removeAccessory: vi.fn(),
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
}

function getDelegateAccessories(delegate: DeviceDelegate): Map<string, unknown> {
    return (delegate as ShellyPlus1Delegate & { accessories: Map<string, unknown> }).accessories;
}

function createPlainDevice(): ShellyPlus1Pm {
    const rpcHandler = new TestRpcHandler();
    const device = new ShellyPlus1Pm(
        {
            id: 'shellyplus1pm-plain',
            mac: 'plain123',
            model: ShellyPlus1Pm.model,
        },
        rpcHandler,
    );

    vi.spyOn(device.shelly, 'getStatus').mockResolvedValue({
        'switch:0': { id: 0, output: false },
    });
    vi.spyOn(device.shelly, 'getConfig').mockResolvedValue({});

    return device;
}

function createAddonDevice(): ShellyPlus1Pm {
    const rpcHandler = new TestRpcHandler();
    const device = new ShellyPlus1Pm(
        {
            id: 'shellyplus1pm-abc123',
            mac: 'abc123',
            model: ShellyPlus1Pm.model,
        },
        rpcHandler,
    );

    vi.spyOn(device.shelly, 'getStatus').mockResolvedValue(ADDON_SENSOR_STATUS);
    vi.spyOn(device.shelly, 'getConfig').mockResolvedValue({
        'temperature:100': { id: 100, name: 'Tank' },
        'humidity:100': { id: 100, name: null },
    });

    return device;
}

describe('Shelly Sensor Add-on support', () => {
    let delegate: DeviceDelegate | undefined;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.useFakeTimers();
        delegate = undefined;
    });

    afterEach(() => {
        delegate?.detach();
        vi.useRealTimers();
    });

    it('resolves SENSOR category for temperature and humidity abilities', () => {
        const temperature = { id: 100 } as Temperature;
        const humidity = { id: 100 } as Humidity;

        expect(
            resolveAccessoryCategory([
                new TemperatureSensorAbility(temperature).setActive(true),
                new HumiditySensorAbility(humidity).setActive(true),
            ]),
        ).toBe(Categories.SENSOR);
    });

    it('creates accessories for add-on temperature probes and a DHT pair', async () => {
        const device = createAddonDevice();
        await device.discoverAddonComponents();

        const platform = createMockPlatform();

        const options: DeviceOptions = {
            exclude: false,
            protocol: 'websocket',
            name: 'Garage Heater',
        };

        delegate = new ShellyPlus1Delegate(device, options, platform);
        await vi.runAllTimersAsync();

        const accessoryIds = [...getDelegateAccessories(delegate).keys()].sort();
        expect(accessoryIds).toEqual([
            'addon-climate-100',
            'addon-temperature-101',
            'addon-temperature-102',
            'addon-temperature-103',
            'addon-temperature-104',
            'switch',
        ]);

        const climateAccessory = (
            delegate as ShellyPlus1Delegate & { accessories: Map<string, { abilities: unknown[]; name: string }> }
        ).accessories.get('addon-climate-100');
        expect(climateAccessory?.abilities.some((ability) => ability instanceof TemperatureSensorAbility)).toBe(true);
        expect(climateAccessory?.abilities.some((ability) => ability instanceof HumiditySensorAbility)).toBe(true);
        expect(climateAccessory?.name).toContain('Tank');
    });

    it('does not create add-on accessories when temperature components are excluded', async () => {
        const device = createAddonDevice();
        await device.discoverAddonComponents();

        const platform = createMockPlatform();

        const options: DeviceOptions = {
            exclude: false,
            protocol: 'websocket',
            'temperature:100': { exclude: true },
            'temperature:101': { exclude: true },
            'temperature:102': { exclude: true },
            'temperature:103': { exclude: true },
            'temperature:104': { exclude: true },
            'humidity:100': { exclude: true },
        };

        delegate = new ShellyPlus1Delegate(device, options, platform);
        await vi.runAllTimersAsync();

        expect([...getDelegateAccessories(delegate).keys()]).toEqual(['switch']);
    });

    it('does not create a standalone humidity accessory when a DHT temperature pair is excluded', async () => {
        const device = createAddonDevice();
        await device.discoverAddonComponents();

        const options: DeviceOptions = {
            exclude: false,
            protocol: 'websocket',
            'temperature:100': { exclude: true },
        };

        delegate = new ShellyPlus1Delegate(device, options, createMockPlatform());
        await vi.runAllTimersAsync();

        expect(getDelegateAccessories(delegate).has('addon-humidity-100')).toBe(false);
        expect(getDelegateAccessories(delegate).has('addon-climate-100')).toBe(false);
    });

    it('creates a temperature-only accessory when humidity is excluded on a DHT pair', async () => {
        const device = createAddonDevice();
        await device.discoverAddonComponents();

        const options: DeviceOptions = {
            exclude: false,
            protocol: 'websocket',
            'humidity:100': { exclude: true },
        };

        delegate = new ShellyPlus1Delegate(device, options, createMockPlatform());
        await vi.runAllTimersAsync();

        expect([...getDelegateAccessories(delegate).keys()].sort()).toEqual([
            'addon-temperature-100',
            'addon-temperature-101',
            'addon-temperature-102',
            'addon-temperature-103',
            'addon-temperature-104',
            'switch',
        ]);
    });

    it('creates only the switch accessory when no add-on sensors are present', async () => {
        const device = createPlainDevice();
        await device.discoverAddonComponents();

        delegate = new ShellyPlus1Delegate(device, { exclude: false, protocol: 'websocket' }, createMockPlatform());
        await vi.runAllTimersAsync();

        expect([...getDelegateAccessories(delegate).keys()]).toEqual(['switch']);
    });

    it('detaches add-on sensor listeners when the delegate is torn down', async () => {
        const device = createAddonDevice();
        await device.discoverAddonComponents();

        delegate = new ShellyPlus1Delegate(device, { exclude: false, protocol: 'websocket' }, createMockPlatform());
        await vi.runAllTimersAsync();

        const temperature = device.getComponent('temperature:100') as Temperature;
        const humidity = device.getComponent('humidity:100') as Humidity;
        const temperatureOff = vi.spyOn(temperature, 'off');
        const humidityOff = vi.spyOn(humidity, 'off');

        delegate.detach();

        expect(temperatureOff).toHaveBeenCalledWith('change:tC', expect.any(Function), expect.anything());
        expect(humidityOff).toHaveBeenCalledWith('change:rh', expect.any(Function), expect.anything());
    });
});
