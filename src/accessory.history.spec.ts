import EventEmitter from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, Service, uuid } from '@homebridge/hap-nodejs';
import { Categories, LogLevel } from 'homebridge';
import type { Device, Humidity, Temperature } from '@lucavb/shellies-ds9';
import type { API, PlatformAccessory } from 'homebridge';

import { Accessory } from './accessory.ts';
import {
    Ability,
    AccessoryInformationAbility,
    HumiditySensorAbility,
    TemperatureSensorAbility,
} from './abilities/index.ts';
import type { ServiceClass } from './abilities/index.ts';
import { setFakegatoLoaderForTesting, WEATHER_HISTORY_SERVICE_UUID } from './history.ts';
import type { FakeGatoHistoryEntry, FakegatoServiceOptions, HistoryKind, WeatherHistoryRecorder } from './history.ts';
import { DeviceLogger } from './utils/device-logger.ts';
import type { ShellyPlatform } from './platform.ts';

const STORAGE_PATH = '/tmp/hap-storage';

let instances: FakeHistoryService[] = [];

/**
 * The fake fakegato global registries of the most recently created mock
 * platform, holding the services that the `FakeHistoryService` constructor
 * self-registers on, mimicking how the real module hangs its timer and
 * storage globals off the API that its factory receives.
 */
let fakegatoRegistries: {
    timerSubscribers: unknown[];
    storageWriters: unknown[];
} | null = null;

/**
 * The API object that the fake fakegato factory last received, from which the
 * `FakeHistoryService` constructor reads the global registries.
 */
let fakegatoApi: API | null = null;

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
 * A fake fakegato weather history service, based on a real HomeKit service.
 * Note that this is NOT a faithful mirror of the real module's topology: the
 * real fakegato module registers a SEPARATE `FakeGatoHistoryService` instance
 * on the platform accessory (fakegato-history.js:464-467) and rebinds it via
 * `this.service`, while this fake registers itself directly. The real
 * topology is covered by the headless test in `history.spec.ts`, which runs
 * the real module against a real accessory contract.
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
        super('History', WEATHER_HISTORY_SERVICE_UUID);
        this.accessoryType = accessoryType;
        this.options = options;
        this.addEntry = vi.fn((entry: FakeGatoHistoryEntry) => {
            this.entries.push(entry);
        });
        instances.push(this);
        this.registerOnAccessory();
        this.registerOnFakegatoRegistries();
    }

    get lastEntry(): number {
        return this.entries.length;
    }

    /**
     * The real fakegato service subscribes itself with the module's global
     * timer and registers itself with the global storage during construction
     * (fakegato-history.js:204, 221). Mirror that, and only when those
     * registries are present on the api object, so that tests without them
     * are unaffected.
     */
    private registerOnFakegatoRegistries() {
        if (fakegatoApi === null || fakegatoRegistries === null) {
            return;
        }

        const api = fakegatoApi as unknown as {
            globalFakeGatoTimer?: { getSubscriber?: (service: unknown) => unknown };
            globalFakeGatoStorage?: { getWriter?: (service: unknown) => unknown };
        };

        if (
            api.globalFakeGatoTimer?.getSubscriber !== undefined &&
            api.globalFakeGatoStorage?.getWriter !== undefined
        ) {
            fakegatoRegistries.timerSubscribers.push(this);
            fakegatoRegistries.storageWriters.push(this);
        }
    }

    private registerOnAccessory() {
        const accessory = this.accessory as unknown as MockPlatformAccessory;
        if (typeof accessory.getService !== 'function') {
            return;
        }

        if (accessory.getService(FakeHistoryService) === undefined) {
            accessory.addService(this as unknown as Service);
        }
    }
}
// mirrors the fakegato module's `FakeGatoHistoryService.UUID` static
Object.assign(FakeHistoryService, { UUID: WEATHER_HISTORY_SERVICE_UUID });

/**
 * A minimal ability that exposes the protected `record()` method, so that a
 * test can pin the recorder lifecycle directly, without going through a
 * HomeKit service.
 */
class RecordProbeAbility extends Ability {
    protected get serviceClass(): ServiceClass {
        // this subclass never attaches to the HomeKit accessory tree
        return undefined as never;
    }

    protected initialize(): void {
        // intentionally empty: this subclass is never set up
    }

    detach(): void {
        // intentionally empty
    }

    probeRecord(kind: HistoryKind, value: number): void {
        this.record(kind, value);
    }
}

function createMockPlatform(cachedAccessory: MockPlatformAccessory | null = null) {
    const timerSubscribers: unknown[] = [];
    const storageWriters: unknown[] = [];

    const api = {
        hap: {
            uuid,
            Characteristic,
            Service,
        },
        platformAccessory: MockPlatformAccessory,
        user: {
            storagePath: () => '/tmp/user-storage',
            persistPath: () => STORAGE_PATH,
        },
        // the global fakegato registries, described the way the real module
        // attaches them to the api and `removeFromFakegatoRegistries()`
        // consumes them: a truthy lookup result means that the service is
        // registered, and unsubscribe()/delWriter() remove it
        globalFakeGatoTimer: {
            getSubscriber: (service: unknown) => (timerSubscribers.includes(service) ? service : undefined),
            unsubscribe: (service: unknown) => {
                const index = timerSubscribers.indexOf(service);
                if (index !== -1) {
                    timerSubscribers.splice(index, 1);
                }
            },
        },
        globalFakeGatoStorage: {
            getWriter: (service: unknown) => (storageWriters.includes(service) ? service : undefined),
            delWriter: (service: unknown) => {
                const index = storageWriters.indexOf(service);
                if (index !== -1) {
                    storageWriters.splice(index, 1);
                }
            },
        },
    };

    fakegatoRegistries = { timerSubscribers, storageWriters };

    return {
        api,
        log: {
            log: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        getAccessory: vi.fn().mockReturnValue(cachedAccessory),
        addAccessory: vi.fn(),
        removeAccessory: vi.fn(),
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
}

function injectFakeLoader(): { loader: ReturnType<typeof vi.fn>; factory: ReturnType<typeof vi.fn> } {
    const factory = vi.fn((api: API) => {
        // the service constructor reads the global registries off the api
        // object, exactly like the real module does
        fakegatoApi = api;
        return FakeHistoryService;
    });
    const loader = vi.fn(() => factory);
    setFakegatoLoaderForTesting(loader);

    return { loader, factory };
}

describe('Accessory history support', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.useFakeTimers();
        instances = [];
        fakegatoRegistries = null;
        fakegatoApi = null;
    });

    afterEach(() => {
        setFakegatoLoaderForTesting(null);
        vi.useRealTimers();
    });

    function setupAccessory(params: {
        temperature?: Temperature;
        temperatureOptions?: { history?: boolean };
        humidity?: Humidity;
        humidityOptions?: { history?: boolean };
        cachedAccessory?: MockPlatformAccessory | null;
    }): { accessory: Accessory; platform: ShellyPlatform } {
        const platform = createMockPlatform(params.cachedAccessory ?? null);
        const log = new DeviceLogger({ id: 'shellyplus1pm-test' } as never, 'Test Device', platform.log);

        const abilities: Ability[] = [new AccessoryInformationAbility(createFakeDevice())];
        if (params.temperature) {
            abilities.push(new TemperatureSensorAbility(params.temperature, params.temperatureOptions));
        }
        if (params.humidity) {
            abilities.push(new HumiditySensorAbility(params.humidity, params.humidityOptions));
        }

        const accessory = new Accessory(
            'addon-climate-100',
            'shellyplus1pm-abc123',
            'Test Sensor',
            platform,
            log,
            ...abilities,
        );

        return { accessory, platform };
    }

    it('records the setup-time seed entry and forwards component changes to the weather service', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent(21.5);
        const humidity = createHumidityComponent(48);
        const { accessory } = setupAccessory({ temperature, humidity });

        await vi.runAllTimersAsync();

        // the recorder was created eagerly, exactly one weather service exists,
        // and it is registered on the platform accessory
        expect(instances).toHaveLength(1);
        const history = instances[0];
        const pa = (accessory.platformAccessory ?? null) as MockPlatformAccessory | null;
        expect(pa).not.toBeNull();
        expect(pa!.services.filter((service) => service.UUID === WEATHER_HISTORY_SERVICE_UUID)).toHaveLength(1);

        // the history file is derived from the accessory UUID
        expect(history.accessoryType).toBe('weather');
        expect(history.options.storage).toBe('fs');
        expect(history.options.path).toBe(STORAGE_PATH);
        expect(history.options.filename).toBe(`${accessory.uuid}.json`);

        // the setup-time seeding of the characteristics is recorded, proving
        // that the recorder was attached before the ability setup loop
        expect(history.addEntry).toHaveBeenCalledWith({ time: expect.any(Number), temp: 21.5 });
        expect(history.addEntry).toHaveBeenCalledWith({ time: expect.any(Number), humidity: 48 });

        // component changes are recorded independently
        temperature.emit('change:tC', 25.5);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 25.5 });

        humidity.emit('change:rh', 55);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), humidity: 55 });
    });

    it('records only temperature when humidity history is disabled', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent();
        const humidity = createHumidityComponent();
        setupAccessory({ temperature, humidity, humidityOptions: { history: false } });

        await vi.runAllTimersAsync();

        // exactly one weather service, for the temperature kind
        expect(instances).toHaveLength(1);
        const history = instances[0];

        // the temperature seed is recorded and changes are forwarded
        temperature.emit('change:tC', 22);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 22 });

        // humidity emissions are not recorded
        const entryCount = history.entries.length;
        humidity.emit('change:rh', 90);
        expect(history.entries).toHaveLength(entryCount);

        // no entry carries a humidity reading
        for (const entry of history.entries) {
            expect(entry.humidity).toBeUndefined();
        }
    });

    it('stops recording entries after the accessory is deactivated', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent();
        const { accessory } = setupAccessory({ temperature });

        await vi.runAllTimersAsync();

        expect(instances).toHaveLength(1);
        const history = instances[0];

        // confirm that entries are recorded while the accessory is active
        temperature.emit('change:tC', 23);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 23 });
        const entryCount = history.entries.length;

        accessory.setActive(false);
        await vi.runAllTimersAsync();

        temperature.emit('change:tC', 24);
        expect(history.entries).toHaveLength(entryCount);
    });

    it('stops recording while inactive and resumes on reactivation', async () => {
        injectFakeLoader();
        const temperature = createTemperatureComponent();
        const { accessory } = setupAccessory({ temperature });

        await vi.runAllTimersAsync();

        // activation: the weather service is constructed, registered on the
        // fakegato registries, and receives the setup-time seed entry
        expect(instances).toHaveLength(1);
        expect(fakegatoRegistries!.timerSubscribers).toHaveLength(1);
        expect(fakegatoRegistries!.storageWriters).toHaveLength(1);
        const history = instances[0];
        temperature.emit('change:tC', 23);
        expect(history.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 23 });

        // deactivation: the recorder is detached from the registries and the
        // ability listeners are gone, so nothing more is recorded
        accessory.setActive(false);
        await vi.runAllTimersAsync();

        expect(instances).toHaveLength(1);
        expect(fakegatoRegistries!.timerSubscribers).toHaveLength(0);
        expect(fakegatoRegistries!.storageWriters).toHaveLength(0);
        const entryCount = history.entries.length;
        temperature.emit('change:tC', 24);
        expect(history.entries).toHaveLength(entryCount);

        // reactivation: a fresh weather service is created, rebinding to the
        // registries and to the freshly seeded characteristic
        accessory.setActive(true);
        await vi.runAllTimersAsync();

        expect(instances).toHaveLength(2);
        const resumed = instances[1];
        expect(resumed).not.toBe(history);
        expect(fakegatoRegistries!.timerSubscribers).toHaveLength(1);
        expect(fakegatoRegistries!.storageWriters).toHaveLength(1);

        // the resumed service receives the setup-time seed as well
        expect(resumed.addEntry).toHaveBeenCalledWith({ time: expect.any(Number), temp: 21.5 });

        temperature.emit('change:tC', 25);
        expect(resumed.addEntry).toHaveBeenLastCalledWith({ time: expect.any(Number), temp: 25 });
    });

    it('keeps working when fakegato-history cannot be loaded', async () => {
        setFakegatoLoaderForTesting(() => null);
        const temperature = createTemperatureComponent();
        const { accessory, platform } = setupAccessory({ temperature });

        await vi.runAllTimersAsync();

        const pa = (accessory.platformAccessory ?? null) as MockPlatformAccessory | null;
        expect(pa).not.toBeNull();

        // the accessory itself is still registered with the platform
        expect(platform.addAccessory).toHaveBeenCalledWith(pa);

        // no weather history service exists
        expect(pa!.services.some((service) => service.UUID === WEATHER_HISTORY_SERVICE_UUID)).toBe(false);
        expect(instances).toHaveLength(0);

        // the failure is reported exactly once
        const errorCalls = vi.mocked(platform.log.log).mock.calls.filter((call) => call[0] === LogLevel.ERROR);
        expect(errorCalls).toHaveLength(1);
        expect(String(errorCalls[0]?.[1])).toContain('fakegato-history');

        // the device keeps working without history
        const temperatureService = pa!.getService(Service.TemperatureSensor);
        expect(temperatureService).toBeDefined();

        const characteristic = temperatureService!.getCharacteristic(Characteristic.CurrentTemperature);
        temperature.emit('change:tC', 30);
        expect(characteristic.value).toBe(30);
    });

    it('a destroyed ability cannot record', () => {
        const ability = new RecordProbeAbility();
        const recordSpy = vi.fn();
        const detachSpy = vi.fn();
        ability.setRecorder({ record: recordSpy, detach: detachSpy } as unknown as WeatherHistoryRecorder);

        // the recorder is attached and receives readings
        ability.probeRecord('temperature', 21.5);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(detachSpy).not.toHaveBeenCalled();

        // destroying the ability clears the recorder
        ability.destroy();

        ability.probeRecord('temperature', 21.5);
        expect(recordSpy).toHaveBeenCalledTimes(1);
    });

    it('does not create a weather service when history is disabled, and removes a stale one', async () => {
        const { loader } = injectFakeLoader();
        const temperature = createTemperatureComponent();

        // pre-seed a cached platform accessory with a stale (frozen) weather
        // history service created while history was still enabled
        const cachedAccessory = new MockPlatformAccessory('Test Sensor', 'cached-uuid', Categories.SENSOR);
        cachedAccessory.addService(new Service('Stale History', WEATHER_HISTORY_SERVICE_UUID));

        const { accessory, platform } = setupAccessory({
            temperature,
            temperatureOptions: { history: false },
            cachedAccessory,
        });

        await vi.runAllTimersAsync();

        const pa = (accessory.platformAccessory ?? null) as MockPlatformAccessory | null;
        // the stale weather service has been removed from the cached accessory
        expect(pa!.services.some((service) => service.UUID === WEATHER_HISTORY_SERVICE_UUID)).toBe(false);
        // nothing was constructed and the loader/factory machinery was never engaged
        expect(instances).toHaveLength(0);
        expect(loader).not.toHaveBeenCalled();
        // no errors are reported when history is disabled
        expect(platform.log.error).not.toHaveBeenCalled();
    });
});
