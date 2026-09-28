import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { API, PlatformAccessory } from 'homebridge';

import { createRecorder, setFakegatoLoaderForTesting, WEATHER_HISTORY_SERVICE_UUID } from './history.ts';
import type { FakeGatoHistoryEntry, FakegatoFactory, FakegatoServiceOptions, HistoryKind } from './history.ts';
import type { DeviceLogger } from './utils/device-logger.ts';

function createFakeLog(): DeviceLogger {
    return {
        log: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    } as unknown as DeviceLogger;
}

interface ServiceLike {
    UUID: string;
}

function createFakePlatformAccessory(): PlatformAccessory {
    const services: ServiceLike[] = [];

    return {
        services,
        getService: () => undefined,
        addService: vi.fn(),
        removeService: vi.fn((service: ServiceLike) => {
            const index = services.indexOf(service);
            if (index !== -1) {
                services.splice(index, 1);
            }
        }),
    } as unknown as PlatformAccessory;
}

/**
 * Fakes the global fakegato timer and storage registries the way the real
 * fakegato-history module attaches them to the homebridge API. Registering a
 * service on them is done by the test itself to simulate the registration the
 * real service constructor performs.
 */
function createFakeApi(persistPathWorks = true) {
    const timerSubscribers: unknown[] = [];
    const storageWriters: unknown[] = [];

    const user = persistPathWorks
        ? { persistPath: () => '/persist', storagePath: () => '/storage' }
        : {
              persistPath: () => {
                  throw new Error('no persist path');
              },
              storagePath: () => {
                  throw new Error('no storage path');
              },
          };

    const timer = {
        getSubscriber: vi.fn((service: unknown) => (timerSubscribers.includes(service) ? service : undefined)),
        unsubscribe: vi.fn((service: unknown) => {
            const index = timerSubscribers.indexOf(service);
            if (index !== -1) {
                timerSubscribers.splice(index, 1);
            }
        }),
    };
    const storage = {
        getWriter: vi.fn((service: unknown) => (storageWriters.includes(service) ? service : undefined)),
        delWriter: vi.fn((service: unknown) => {
            const index = storageWriters.indexOf(service);
            if (index !== -1) {
                storageWriters.splice(index, 1);
            }
        }),
    };

    return {
        api: { user, globalFakeGatoTimer: timer, globalFakeGatoStorage: storage } as unknown as API,
        timerSubscribers,
        storageWriters,
        timer,
        storage,
    };
}

/**
 * Creates a fake fakegato-history factory together with the service instances
 * that it (indirectly, via the returned class) constructs.
 */
function createFakeFactory(): {
    factory: Mock;
    loader: Mock;
    created: {
        readonly accessoryType: string;
        readonly accessory: PlatformAccessory;
        readonly options: FakegatoServiceOptions;
        readonly addEntry: Mock;
        lastEntry: number;
    }[];
} {
    const created: {
        readonly accessoryType: string;
        readonly accessory: PlatformAccessory;
        readonly options: FakegatoServiceOptions;
        readonly addEntry: Mock;
        lastEntry: number;
    }[] = [];

    class FakeHistoryService {
        readonly accessoryType: string;
        readonly accessory: PlatformAccessory;
        readonly options: FakegatoServiceOptions;
        readonly addEntry: Mock;
        lastEntry = 0;

        constructor(accessoryType: string, accessory: PlatformAccessory, options: FakegatoServiceOptions) {
            this.accessoryType = accessoryType;
            this.accessory = accessory;
            this.options = options;
            this.addEntry = vi.fn();
            created.push(this);
        }
    }

    const factory: Mock = vi.fn((_api: API) => FakeHistoryService);
    const loader: Mock = vi.fn(() => factory);

    return { factory, loader, created };
}

function createStaleWeatherAccessory(): { pa: PlatformAccessory; staleService: ServiceLike; kept: ServiceLike } {
    const pa = createFakePlatformAccessory();
    const staleService: ServiceLike = { UUID: WEATHER_HISTORY_SERVICE_UUID };
    const kept: ServiceLike = { UUID: 'some-other-service' };
    (pa.services as unknown as ServiceLike[]).push(staleService, kept);

    return { pa, staleService, kept };
}

describe('createRecorder()', () => {
    beforeEach(() => {
        setFakegatoLoaderForTesting(null);
        vi.restoreAllMocks();
    });

    afterEach(() => {
        setFakegatoLoaderForTesting(null);
    });

    it('constructs the fakegato weather service eagerly with the expected options', () => {
        const { api } = createFakeApi();
        const { pa } = createStaleWeatherAccessory();
        const log = createFakeLog();
        const { loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        const kinds: HistoryKind[] = ['temperature', 'humidity'];
        const recorder = createRecorder(pa, api, 'sensor-1', log, kinds);

        // the service is constructed immediately, not lazily on the first reading
        expect(created).toHaveLength(1);

        const service = created[0];
        expect(service.accessoryType).toBe('weather');
        expect(service.accessory).toBe(pa);

        expect(service.options.storage).toBe('fs');
        expect(service.options.path).toBe('/persist');
        expect(service.options.filename).toBe('sensor-1.json');

        // the adapted fakegato log forwards to the plugin logger
        service.options.log.debug('hello');
        expect(log.debug).toHaveBeenCalledWith('hello');

        // nothing was logged
        expect(log.error).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();

        // the recorder is active and detached from nothing yet
        expect(() => recorder.record('temperature', 21.5)).not.toThrow();
    });

    it('constructs the service through the injected loader', () => {
        const { api } = createFakeApi();
        const log = createFakeLog();
        const { factory, loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, ['temperature']);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(api);
        expect(created).toHaveLength(1);
    });

    it('caches the loader per API instance', () => {
        const { api } = createFakeApi();
        const log = createFakeLog();
        const { factory, loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, ['temperature']);
        createRecorder(createFakePlatformAccessory(), api, 'sensor-2', log, ['humidity']);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(api);

        // each recorder gets its own service instance
        expect(created).toHaveLength(2);
        expect(created[1]).not.toBe(created[0]);
    });

    it('forwards temperature and humidity readings with a recorder-supplied timestamp', () => {
        const { api } = createFakeApi();
        const log = createFakeLog();
        const { loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        const kinds: HistoryKind[] = ['temperature', 'humidity'];
        const recorder = createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, kinds);

        vi.spyOn(Date, 'now').mockReturnValue(1_708_051_234_567);

        recorder.record('temperature', 21.5);
        recorder.record('humidity', 55);

        const entries = created[0].addEntry.mock.calls.map((call) => call[0] as FakeGatoHistoryEntry);
        expect(entries).toEqual([
            { time: 1_708_051_234, temp: 21.5 },
            { time: 1_708_051_234, humidity: 55 },
        ]);
    });

    it('is inert and removes the stale weather service when no kinds are given', () => {
        const { api } = createFakeApi();
        const { pa, staleService, kept } = createStaleWeatherAccessory();
        const log = createFakeLog();
        const { loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        const recorder = createRecorder(pa, api, 'sensor-1', log, []);

        expect(loader).not.toHaveBeenCalled();
        expect(created).toHaveLength(0);

        // the stale weather service was removed, other services were kept
        expect(pa.services).not.toContain(staleService);
        expect(pa.services).toContain(kept);

        // and the recorder is inert
        expect(() => {
            recorder.record('temperature', 20);
            recorder.record('humidity', 50);
            recorder.detach();
        }).not.toThrow();
    });

    it('warns once and removes the stale weather service when the storage path cannot be resolved', () => {
        const { api } = createFakeApi(false);
        const { pa, staleService, kept } = createStaleWeatherAccessory();
        const log = createFakeLog();
        const { loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        const recorder = createRecorder(pa, api, 'sensor-1', log, ['temperature']);

        expect(loader).not.toHaveBeenCalled();
        expect(created).toHaveLength(0);

        // exactly one warning
        expect(log.warn).toHaveBeenCalledTimes(1);

        // the stale weather service was removed, other services were kept
        expect(pa.services).not.toContain(staleService);
        expect(pa.services).toContain(kept);

        // and the recorder is inert
        expect(() => {
            recorder.record('temperature', 20);
            recorder.detach();
        }).not.toThrow();
    });

    it('logs an error once and removes the stale weather service when the loader yields no factory', () => {
        const { api } = createFakeApi();
        const { pa, staleService, kept } = createStaleWeatherAccessory();
        const log = createFakeLog();

        setFakegatoLoaderForTesting(() => null);

        const recorder = createRecorder(pa, api, 'sensor-1', log, ['temperature']);

        // the failure is logged once, by the loader machinery, and nothing was constructed
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(
            'Failed to load fakegato-history: the module does not export a factory function.',
        );

        // the stale weather service was removed, other services were kept
        expect(pa.services).not.toContain(staleService);
        expect(pa.services).toContain(kept);

        // and the recorder is inert
        expect(() => {
            recorder.record('temperature', 20);
            recorder.detach();
        }).not.toThrow();
    });

    it('logs an error once and removes the stale weather service when the loader throws', () => {
        const { api } = createFakeApi();
        const { pa, staleService, kept } = createStaleWeatherAccessory();
        const log = createFakeLog();

        setFakegatoLoaderForTesting(() => {
            throw new Error('factory boom');
        });

        const recorder = createRecorder(pa, api, 'sensor-1', log, ['temperature']);

        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith('Failed to load fakegato-history:', 'factory boom');

        // the stale weather service was removed, other services were kept
        expect(pa.services).not.toContain(staleService);
        expect(pa.services).toContain(kept);

        // and the recorder is inert
        expect(() => {
            recorder.record('temperature', 20);
            recorder.detach();
        }).not.toThrow();
    });

    it('logs an error once and removes the stale weather service when the factory throws', () => {
        const { api } = createFakeApi();
        const { pa, staleService, kept } = createStaleWeatherAccessory();
        const log = createFakeLog();

        // the loader succeeds, but the factory it yields throws when called
        setFakegatoLoaderForTesting(
            () =>
                (() => {
                    throw new Error('factory boom');
                }) as unknown as FakegatoFactory,
        );

        const recorder = createRecorder(pa, api, 'sensor-1', log, ['temperature']);

        // the failure is logged once, by the loader machinery, and nothing was constructed
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith('Failed to load fakegato-history:', 'factory boom');

        // the stale weather service was removed, other services were kept
        expect(pa.services).not.toContain(staleService);
        expect(pa.services).toContain(kept);

        // and the recorder is inert
        expect(() => {
            recorder.record('temperature', 20);
            recorder.detach();
        }).not.toThrow();
    });

    it('caches loader failures, so that the loader is not called again', () => {
        const { api } = createFakeApi();
        const log = createFakeLog();
        const loader = vi.fn(() => null);
        setFakegatoLoaderForTesting(loader);

        createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, ['temperature']);
        createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, ['temperature']);

        // the loader machinery is invoked at most once per API instance
        expect(loader).toHaveBeenCalledTimes(1);

        // so the error is only logged once
        expect(log.error).toHaveBeenCalledTimes(1);
    });

    it('removes every stale weather service when no history could be set up', () => {
        const { api } = createFakeApi();
        const pa = createFakePlatformAccessory();
        const firstStale: ServiceLike = { UUID: WEATHER_HISTORY_SERVICE_UUID };
        const secondStale: ServiceLike = { UUID: WEATHER_HISTORY_SERVICE_UUID };
        const kept: ServiceLike = { UUID: 'some-other-service' };
        (pa.services as unknown as ServiceLike[]).push(firstStale, kept, secondStale);
        const log = createFakeLog();

        setFakegatoLoaderForTesting(() => null);

        createRecorder(pa, api, 'sensor-1', log, ['temperature']);

        // both stale weather services were removed, other services were kept
        expect(pa.services).not.toContain(firstStale);
        expect(pa.services).not.toContain(secondStale);
        expect(pa.services).toContain(kept);
    });

    it('detach() unregisters the recorder from the fakegato registries and is idempotent', () => {
        const { api, timerSubscribers, storageWriters, timer, storage } = createFakeApi();
        const log = createFakeLog();
        const { loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        const recorder = createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, ['temperature']);

        // simulate the registration the real fakegato constructor performs on the globals
        const service = created[0];
        timerSubscribers.push(service);
        storageWriters.push(service);

        recorder.detach();

        expect(timerSubscribers).toHaveLength(0);
        expect(storageWriters).toHaveLength(0);
        expect(timer.unsubscribe).toHaveBeenCalledWith(service);
        expect(storage.delWriter).toHaveBeenCalledWith(service);

        // a second detach is a no-op
        recorder.detach();
        expect(timer.unsubscribe).toHaveBeenCalledTimes(1);
        expect(storage.delWriter).toHaveBeenCalledTimes(1);
    });

    it('detach() leaves unregistered services alone (upstream splice(-1) guard)', () => {
        const { api, timerSubscribers, storageWriters, timer, storage } = createFakeApi();
        const log = createFakeLog();
        const { loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        const unrelated = { UUID: 'unrelated' };
        timerSubscribers.push(unrelated);
        storageWriters.push(unrelated);

        const recorder = createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, ['temperature']);

        recorder.detach();

        // an innocent registered entry must not be removed
        expect(timer.unsubscribe).not.toHaveBeenCalled();
        expect(storage.delWriter).not.toHaveBeenCalled();
        expect(timerSubscribers).toEqual([unrelated]);
        expect(storageWriters).toEqual([unrelated]);
        expect(created[0].addEntry).not.toHaveBeenCalled();
    });

    it('record() is a no-op after detach()', () => {
        const { api, timerSubscribers, storageWriters } = createFakeApi();
        const log = createFakeLog();
        const { loader, created } = createFakeFactory();
        setFakegatoLoaderForTesting(loader as unknown as () => FakegatoFactory | null);

        const recorder = createRecorder(createFakePlatformAccessory(), api, 'sensor-1', log, ['temperature']);

        timerSubscribers.push(created[0]);
        storageWriters.push(created[0]);

        recorder.detach();
        recorder.record('temperature', 20);

        expect(created[0].addEntry).not.toHaveBeenCalled();
    });
});
