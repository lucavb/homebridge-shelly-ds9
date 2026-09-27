import { createRequire } from 'node:module';

import type { API, LogLevel, PlatformAccessory } from 'homebridge';

import type { DeviceLogger } from './utils/device-logger.ts';

/**
 * The UUID of the fakegato "weather" history service.
 * This must match the module's `FakeGatoHistoryService.UUID`
 * (fakegato-history.js:143).
 */
export const WEATHER_HISTORY_SERVICE_UUID = 'E863F007-079E-48FF-8F27-9C2605A29F52';

/**
 * A single entry in a fakegato history.
 */
export interface FakeGatoHistoryEntry {
    /**
     * Time of the reading, as a UNIX timestamp in seconds.
     */
    time: number;
    /**
     * The temperature reading in degrees Celsius.
     */
    temp?: number;
    /**
     * The relative humidity reading in percent.
     */
    humidity?: number;
}

/**
 * A logging device as expected by fakegato-history.
 * Homebridge's logging devices are callable, but fakegato may also use the
 * dedicated logging methods, so both shapes are provided.
 * Note: the installed module (0.6.7) only ever calls `log.debug(...)`. The
 * extra bindings below are kept as harmless drift tolerance.
 */
export interface FakegatoLog {
    prefix?: string;
    (message: string, ...parameters: unknown[]): void;
    info: (message: string, ...parameters: unknown[]) => void;
    success: (message: string, ...parameters: unknown[]) => void;
    warn: (message: string, ...parameters: unknown[]) => void;
    error: (message: string, ...parameters: unknown[]) => void;
    debug: (message: string, ...parameters: unknown[]) => void;
    log: (level: LogLevel, message: string, ...parameters: unknown[]) => void;
}

/**
 * The options that are passed to a fakegato history service.
 */
export interface FakegatoServiceOptions {
    log: FakegatoLog;
    storage: 'fs';
    path?: string;
    filename?: string;
}

export interface FakeGatoHistoryService {
    /**
     * Adds an entry to the history.
     */
    addEntry(entry: FakeGatoHistoryEntry): void;
    /**
     * The index of the most recent entry in the ring buffer.
     */
    lastEntry: number;
}

/**
 * Describes a fakegato history service class, as returned by the
 * fakegato-history factory.
 */
export interface FakeGatoHistoryServiceClass {
    new (accessoryType: string, accessory: PlatformAccessory, options: FakegatoServiceOptions): FakeGatoHistoryService;
}

/**
 * Describes the fakegato-history module's default export.
 * It maps a Homebridge API instance to a history service class.
 */
export type FakegatoFactory = (api: API) => FakeGatoHistoryServiceClass;

/**
 * The accessory types that are supported by the history service.
 * Note that upstream accepts more types; only the ones this plugin uses are
 * listed here.
 */
export type FakegatoHistoryType = 'weather';

/**
 * A loader that returns the fakegato-history factory.
 * Used to inject a fake loader in tests.
 */
export type FakegatoLoader = () => FakegatoFactory | null;

/**
 * Describes the global fakegato timer that the history service subscribes to.
 * The guards are needed because the upstream `unsubscribe()` implementation
 * removes the last registered subscriber if the given service is not
 * registered (its `_getSubscriberIndex()` returns -1, which makes
 * `splice(-1, 1)` remove an innocent entry and can crash another accessory's
 * next save).
 */
export interface FakegatoTimerLike {
    getSubscriber?(service: unknown): unknown;
    unsubscribe?(service: unknown): void;
    stop?(): void;
}

/**
 * Describes the global fakegato storage that the history service registers a
 * writer with. The guards are needed because the upstream `delWriter()`
 * implementation has the same `splice(-1)` bug as the timer.
 */
export interface FakegatoStorageLike {
    getWriter?(service: unknown): unknown;
    delWriter?(service: unknown): void;
}

/**
 * Describes how history data should be recorded for an accessory.
 * A missing flag means that the corresponding kind of readings should be
 * recorded.
 */
export interface HistoryOptions {
    /**
     * Whether temperature readings should be recorded.
     */
    temp?: boolean;
    /**
     * Whether humidity readings should be recorded.
     */
    humidity?: boolean;
}

/**
 * The options for `makeHistoryService()`.
 */
export interface HistoryServiceOptions {
    log: DeviceLogger;
    storage: 'fs';
    path: string;
    filename: string;
}

/**
 * Maps API instances to their loaded history service class. The fakegato
 * factory has to be called at most once per API instance, so the result is
 * cached here.
 */
const historyServiceClasses = new WeakMap<API, FakeGatoHistoryServiceClass | null>();

/**
 * Test hook used to replace the fakegato-history loader in tests, so that the
 * real module (and its global timer) is never instantiated in tests.
 * A value of `null` restores the default loader.
 */
let fakegatoLoaderForTesting: FakegatoLoader | null = null;

/**
 * Replaces the fakegato-history loader used by `makeHistoryService()`.
 * Pass `null` to restore the default loader.
 * @param loader - The loader to use, or `null` to restore the default loader.
 */
export function setFakegatoLoaderForTesting(loader: FakegatoLoader | null) {
    fakegatoLoaderForTesting = loader;
}

/**
 * Loads the fakegato-history factory using a CommonJS `require`.
 * @returns The factory, or `null` if the module could not be resolved.
 */
function loadFakegatoFactory(): FakegatoFactory | null {
    const loaded: unknown = createRequire(import.meta.url)('fakegato-history');

    return typeof loaded === 'function' ? (loaded as FakegatoFactory) : null;
}

/**
 * Returns the fakegato history service class for the given API instance.
 * The factory is invoked at most once per API instance.
 * @param api - A reference to the homebridge API.
 * @param log - The logger to use.
 */
function resolveHistoryServiceClass(api: API, log: DeviceLogger): FakeGatoHistoryServiceClass | null {
    const cached = historyServiceClasses.get(api);
    if (cached !== undefined) {
        return cached;
    }

    let serviceClass: FakeGatoHistoryServiceClass | null = null;

    try {
        const factory = fakegatoLoaderForTesting !== null ? fakegatoLoaderForTesting() : loadFakegatoFactory();

        if (typeof factory === 'function') {
            serviceClass = factory(api);
        } else {
            log.error('Failed to load fakegato-history: the module does not export a factory function.');
        }
    } catch (e) {
        serviceClass = null;
        log.error('Failed to load fakegato-history:', e instanceof Error ? e.message : e);
    }

    // cache the result, even on failure, so that the factory is not called again for this API
    historyServiceClasses.set(api, serviceClass);

    return serviceClass;
}

/**
 * Adapts this plugin's logger to the shape that fakegato-history expects.
 * @param log - The logger to use.
 */
function createFakegatoLog(log: DeviceLogger): FakegatoLog {
    const fakegatoLog = ((message: string, ...parameters: unknown[]) => {
        log.info(message, ...parameters);
    }) as FakegatoLog;

    fakegatoLog.info = log.info.bind(log);
    fakegatoLog.success = log.info.bind(log);
    fakegatoLog.warn = log.warn.bind(log);
    fakegatoLog.error = log.error.bind(log);
    fakegatoLog.debug = log.debug.bind(log);
    fakegatoLog.log = log.log.bind(log);

    return fakegatoLog;
}

/**
 * Creates a fakegato history service for the given platform accessory.
 * Never throws. Returns `null` if fakegato-history is unavailable or cannot be
 * initialised; in that case the plugin keeps working without history.
 * @param api - A reference to the homebridge API.
 * @param type - The fakegato accessory type, e.g. `weather`.
 * @param accessory - The platform accessory to create the history service for.
 * @param options - The options for the history service.
 */
export function makeHistoryService(
    api: API,
    type: FakegatoHistoryType,
    accessory: PlatformAccessory,
    options: HistoryServiceOptions,
): FakeGatoHistoryService | null {
    const serviceClass = resolveHistoryServiceClass(api, options.log);
    if (serviceClass === null) {
        return null;
    }

    const fakegatoOptions: FakegatoServiceOptions = {
        log: createFakegatoLog(options.log),
        storage: options.storage,
        path: options.path,
        filename: options.filename,
    };

    try {
        return new serviceClass(type, accessory, fakegatoOptions);
    } catch (e) {
        options.log.error('Failed to create the history service:', e instanceof Error ? e.message : e);
        return null;
    }
}

/**
 * Removes the history service from the global fakegato timer and storage
 * registries, completing the teardown of the service.
 * Both lookups and removals are guarded, because the upstream removal
 * implementations have a `splice(-1)` bug that deletes an innocent registered
 * subscriber when the given service is not registered, which can crash another
 * accessory's next save.
 * @param api - A reference to the homebridge API.
 * @param service - The history service to remove from the registries.
 */
export function removeFromFakegatoRegistries(api: API, service: FakeGatoHistoryService) {
    // the fakegato globals are added to the API by the module itself and are
    // therefore not part of the homebridge typings
    const fakegatoGlobals = api as unknown as {
        globalFakeGatoTimer?: FakegatoTimerLike;
        globalFakeGatoStorage?: FakegatoStorageLike;
    };

    try {
        const timer = fakegatoGlobals.globalFakeGatoTimer;

        if (timer?.getSubscriber && timer.getSubscriber(service) && timer.unsubscribe) {
            timer.unsubscribe(service);
        }
    } catch {
        // keep the plugin functional if the timer's shape differs
    }

    try {
        const storage = fakegatoGlobals.globalFakeGatoStorage;

        if (storage?.getWriter && storage.getWriter(service) && storage.delWriter) {
            storage.delWriter(service);
        }
    } catch {
        // keep the plugin functional if the storage's shape differs
    }
}
