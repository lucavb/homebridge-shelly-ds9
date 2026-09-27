import EventEmitter from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import { Categories } from 'homebridge';
import type { Device, Humidity, Temperature } from '@lucavb/shellies-ds9';
import type { API, PlatformAccessory } from 'homebridge';

import { Accessory } from './accessory.ts';
import {
    Ability,
    AccessoryInformationAbility,
    HumiditySensorAbility,
    TemperatureSensorAbility,
} from './abilities/index.ts';
import { setFakegatoLoaderForTesting } from './history.ts';
import type { FakeGatoHistoryEntry, FakegatoServiceOptions } from './history.ts';
import { DeviceLogger } from './utils/device-logger.ts';
import type { ShellyPlatform } from './platform.ts';

const WEATHER_UUID = 'E863F007-079E-48FF-8F27-9C2605A29F52';
const STORAGE_PATH = '/tmp/hap-storage';

let instances: FakeHistoryService[] = [];

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

function createHumidityComponent(initialRh: number | null = 48): Humidity {
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

function createFakeDevice(): Device {
    return {
        modelName: 'Shelly Plus 1PM',
        macAddress: 'abc123',
        firmware: { version: '1.0.0' },
    } as unknown as Device;
}

class MockPlatformAccessory {
    context: Record<string, unknown> = {};
    readonly services: Service[] = [];

    constructor(
        readonly displayName: string,
        readonly uuid: string,
        readonly category: Categories,
    ) {
        // a HomeKit accessory always has an accessory information service
        this.services.push(new Service.AccessoryInformation());
    }

    addService(serviceClassOrService: unknown, name?: string, subtype?: string): Service {
        const service =
            typeof serviceClassOrService === 'function'
                ? new (serviceClassOrService as { new (name?: string, subtype?: string): Service })(name, subtype)
                : (serviceClassOrService as Service);

        this.services.push(service);

        return service;
    }

    // the real contract fakegato (and the abilities) depend on
    getService(nameOrClass: string | typeof Service): Service | undefined {
        const targetUuid =
            typeof nameOrClass === 'string' ? nameOrClass : (nameOrClass as unknown as { UUID: string }).UUID;
        return this.services.find((service) => service.UUID === targetUuid);
    }

    removeService(service: Service) {
        const index = this.services.indexOf(service);
        if (index >= 0) {
            this.services.splice(index, 1);
        }
    }
}

/**
 * The separate service object that the real fakegato module adds to the
 * accessory: mirror of the module's `FakeGatoHistoryService` class, which
 * carries the same UUID but is not the plugin's history service object itself.
 */
class FakeHistoryServiceStub extends Service {
    constructor(displayName?: string, subtype?: string) {
        super(displayName, WEATHER_UUID, subtype);
    }
}
// mirrors the module's `FakeGatoHistoryService.UUID` static
Object.assign(FakeHistoryServiceStub, { UUID: WEATHER_UUID });

/**
 * A fake fakegato weather history service, based on a real HomeKit service.
 * It mimics the real module's self-registration: during construction a SEPARATE
 * service instance is added to the platform accessory (see registerEvents() in
 * fakegato-history.js), unless the accessory already carries the service.
 */
class FakeHistoryService extends Service {
    readonly accessoryType: string;
    readonly options: FakegatoServiceOptions;
    readonly entries: FakeGatoHistoryEntry[] = [];
    readonly addEntry: (entry: FakeGatoHistoryEntry) => void;

    constructor(
        accessoryType: string,
        readonly accessory: PlatformAccessory,
        options: FakegatoServiceOptions,
    ) {
        super('History', WEATHER_UUID);
        this.accessoryType = accessoryType;
        this.options = options;
        this.addEntry = vi.fn((entry: FakeGatoHistoryEntry) => {
            this.entries.push(entry);
        });
        instances.push(this);
        this.registerOnAccessory();
    }

    get lastEntry(): number {
        return this.entries.length;
    }

    private registerOnAccessory() {
        const accessory = this.accessory as unknown as MockPlatformAccessory;
        if (typeof accessory.getService !== 'function') {
            return;
        }

        if (accessory.getService(FakeHistoryServiceStub) === undefined) {
            accessory.addService(FakeHistoryServiceStub, `${accessory.displayName} History`, this.accessoryType);
        }
    }
}

function createMockPlatform(cachedAccessory: MockPlatformAccessory | null = null) {
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
                HAPStorage: {
                    storage: () => ({ options: { dir: STORAGE_PATH } }),
                },
            },
            platformAccessory: MockPlatformAccessory,
            user: {
                storagePath: () => '/tmp/user-storage',
            },
        },
        getAccessory: vi.fn().mockReturnValue(cachedAccessory),
        addAccessory: vi.fn(),
        removeAccessory: vi.fn(),
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
}

function injectFakeLoader(): { loader: ReturnType<typeof vi.fn>; factory: ReturnType<typeof vi.fn> } {
    const factory = vi.fn((_api: API) => FakeHistoryService);
    const loader = vi.fn(() => factory);
    setFakegatoLoaderForTesting(loader);

    return { loader, factory };
}

describe('Accessory history support', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.useFakeTimers();
        instances = [];
    });

    afterEach(() => {
        setFakegatoLoaderForTesting(null);
        vi.useRealTimers();
    });

    function setupAccessory(params: {
        temperature?: Temperature;
        humidity?: Humidity;
        history?: { temp?: boolean; humidity?: boolean };
        cachedAccessory?: MockPlatformAccessory | null;
    }): { accessory: Accessory; platform: ShellyPlatform; temperature?: Temperature; humidity?: Humidity } {
        const platform = createMockPlatform(params.cachedAccessory ?? null);
        const log = new DeviceLogger({ id: 'shellyplus1pm-test' } as never, 'Test Device', platform.log);

        const abilities: Ability[] = [new AccessoryInformationAbility(createFakeDevice())];
        if (params.temperature) {
            abilities.push(new TemperatureSensorAbility(params.temperature));
        }
        if (params.humidity) {
            abilities.push(new HumiditySensorAbility(params.humidity));
        }

        const accessory = new Accessory(
            'addon-climate-100',
            'shellyplus1pm-abc123',
            'Test Sensor',
            platform,
            log,
            params.history,
            ...abilities,
        );

        return { accessory, platform, temperature: params.temperature, humidity: params.humidity };
    }

    it('creates exactly one weather history service and feeds temperature and humidity entries', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent();
        const humidity = createHumidityComponent();
        const { accessory } = setupAccessory({ temperature, humidity });

        await vi.runAllTimersAsync();

        const pa = (accessory.platformAccessory ?? null) as MockPlatformAccessory | null;
        expect(pa).not.toBeNull();

        const historyServices = pa!.services.filter((service) => service.UUID === WEATHER_UUID);
        expect(historyServices).toHaveLength(1);
        expect(instances).toHaveLength(1);

        const history = instances[0];
        expect(history.accessoryType).toBe('weather');
        expect(history.options.storage).toBe('fs');
        expect(history.options.path).toBe(STORAGE_PATH);
        // the filename is derived from the accessory UUID, not the name or hostname
        expect(history.options.filename).toBe(`${accessory.uuid}.json`);

        // the initial values are pushed as entries when the accessory is activated
        expect(history.addEntry).toHaveBeenCalledWith({ time: expect.any(Number), temp: 21.5 });
        expect(history.addEntry).toHaveBeenCalledWith({ time: expect.any(Number), humidity: 48 });

        // characteristic changes are recorded independently
        temperature?.emit('change:tC', 25.5);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 25.5 });

        humidity?.emit('change:rh', 55);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), humidity: 55 });
    });

    it('does not create a history service when history is disabled', async () => {
        const { loader } = injectFakeLoader();
        const temperature = createTemperatureComponent();
        const humidity = createHumidityComponent();

        // pre-seed a cached platform accessory with a stale (frozen) history
        // service created while history was still enabled
        const cachedAccessory = new MockPlatformAccessory('Test Sensor', 'cached-uuid', Categories.SENSOR);
        cachedAccessory.addService(new Service('Stale History', WEATHER_UUID));

        const { accessory, platform } = setupAccessory({
            temperature,
            humidity,
            history: { temp: false, humidity: false },
            cachedAccessory,
        });

        await vi.runAllTimersAsync();

        const pa = (accessory.platformAccessory ?? null) as MockPlatformAccessory | null;
        // the frozen history service has been removed from the cached accessory
        expect(pa!.services.some((service) => service.UUID === WEATHER_UUID)).toBe(false);
        expect(instances).toHaveLength(0);
        expect(loader).not.toHaveBeenCalled();
        // no errors are reported when history is disabled
        expect(platform.log.error).not.toHaveBeenCalled();
    });

    it('only records the kinds of readings that are enabled', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent();
        const humidity = createHumidityComponent();
        setupAccessory({ temperature, humidity, history: { humidity: false } });

        await vi.runAllTimersAsync();

        expect(instances).toHaveLength(1);
        const history = instances[0];

        temperature?.emit('change:tC', 22);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 22 });

        humidity?.emit('change:rh', 90);
        for (const entry of history.entries) {
            expect(entry.humidity).toBeUndefined();
        }
    });

    it('records only temperature for a temperature-only accessory', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent(20);
        setupAccessory({ temperature });

        await vi.runAllTimersAsync();

        expect(instances).toHaveLength(1);
        const history = instances[0];

        temperature?.emit('change:tC', 19.5);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 19.5 });
        expect(history.addEntry).toHaveBeenCalledWith({ time: expect.any(Number), temp: 20 });
        for (const entry of history.entries) {
            expect(entry.humidity).toBeUndefined();
        }
    });

    it('stops recording entries after the accessory is detached', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent();
        const { accessory } = setupAccessory({ temperature });

        await vi.runAllTimersAsync();

        expect(instances).toHaveLength(1);
        const history = instances[0];

        // confirm that entries are recorded while the accessory is active
        temperature?.emit('change:tC', 23);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 23 });
        const entryCount = history.entries.length;

        // run the public detach path, mirroring the ability detach tests
        accessory.setActive(false);
        await vi.runAllTimersAsync();

        temperature?.emit('change:tC', 24);
        expect(history.entries).toHaveLength(entryCount);
    });

    it('keeps working without fakegato-history, while the abilities continue to function', async () => {
        setFakegatoLoaderForTesting(() => null);
        const temperature = createTemperatureComponent();
        const humidity = createHumidityComponent();
        const { accessory, platform } = setupAccessory({ temperature, humidity });

        await vi.runAllTimersAsync();

        const pa = (accessory.platformAccessory ?? null) as MockPlatformAccessory | null;
        expect(pa!.services.some((service) => service.UUID === WEATHER_UUID)).toBe(false);
        expect(platform.log.log).toHaveBeenCalledWith('error', expect.stringContaining('fakegato-history'));

        // the abilities are unaffected
        const temperatureService = pa!.getService(Service.TemperatureSensor);
        expect(temperatureService).toBeDefined();

        const characteristic = temperatureService!.getCharacteristic(Characteristic.CurrentTemperature);
        temperature?.emit('change:tC', 30);
        expect(characteristic.value).toBe(30);
    });
});
