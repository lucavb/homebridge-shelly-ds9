import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as hapNodejs from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';

import { makeHistoryService, setFakegatoLoaderForTesting, WEATHER_HISTORY_SERVICE_UUID } from './history.ts';
import type { FakegatoFactory, FakegatoServiceOptions, HistoryServiceOptions } from './history.ts';
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

function createFakePlatformAccessory(): PlatformAccessory {
    return {
        services: [],
        getService: () => undefined,
        addService: vi.fn(),
    } as unknown as PlatformAccessory;
}

function createCredentials(): { api: API; accessory: PlatformAccessory; log: DeviceLogger } {
    return {
        api: {} as unknown as API,
        accessory: createFakePlatformAccessory(),
        log: createFakeLog(),
    };
}

describe('makeHistoryService()', () => {
    let accessory: PlatformAccessory;
    let api: API;
    let log: DeviceLogger;

    beforeEach(() => {
        setFakegatoLoaderForTesting(null);
        vi.restoreAllMocks();

        const credentials = createCredentials();
        api = credentials.api;
        accessory = credentials.accessory;
        log = credentials.log;
    });

    afterEach(() => {
        setFakegatoLoaderForTesting(null);
    });

    it('loads the fakegato service class once per API instance', () => {
        class FakeHistoryService {
            readonly accessoryType: string;
            readonly options: FakegatoServiceOptions;

            constructor(accessoryType: string, accessory: PlatformAccessory, options: FakegatoServiceOptions) {
                this.accessoryType = accessoryType;
                this.options = options;
            }

            addEntry = vi.fn();
            lastEntry = 0;
        }

        const factory = vi.fn((_api: API) => FakeHistoryService);
        const loader = vi.fn(() => factory);
        setFakegatoLoaderForTesting(loader);

        const storageOptions: { storage: 'fs'; path: string; filename: string } = {
            storage: 'fs',
            path: '/tmp/storage',
            filename: 'history.json',
        };

        const first = makeHistoryService(api, 'weather', accessory, { log, ...storageOptions });
        const second = makeHistoryService(api, 'weather', accessory, { log, ...storageOptions });

        expect(first).toBeInstanceOf(FakeHistoryService);
        expect(second).toBeInstanceOf(FakeHistoryService);
        expect(second).not.toBe(first);

        // both the loader and the fakegato factory must only be called once for this API
        expect(loader).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(api);

        // the options are forwarded to the created service
        const service = first as unknown as { accessoryType: string; options: FakegatoServiceOptions };
        expect(service.accessoryType).toBe('weather');
        expect(service.options.filename).toBe('history.json');
        expect(service.options.path).toBe('/tmp/storage');
    });

    it('returns null and logs an error when the loader fails', () => {
        setFakegatoLoaderForTesting(() => null);

        expect(
            makeHistoryService(api, 'weather', accessory, { log, storage: 'fs', path: '.', filename: 'h.json' }),
        ).toBeNull();
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(
            'Failed to load fakegato-history: the module does not export a factory function.',
        );
    });

    it('does not throw when the loader throws', () => {
        setFakegatoLoaderForTesting(() => {
            throw new Error('boom');
        });

        expect(() =>
            makeHistoryService(api, 'weather', accessory, { log, storage: 'fs', path: '.', filename: 'h.json' }),
        ).not.toThrow();

        expect(
            makeHistoryService(api, 'weather', accessory, { log, storage: 'fs', path: '.', filename: 'h.json' }),
        ).toBeNull();
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith('Failed to load fakegato-history:', 'boom');
    });

    it('does not throw when the factory throws', () => {
        const failingFactory = (): unknown => {
            throw new Error('factory boom');
        };
        setFakegatoLoaderForTesting(() => failingFactory as unknown as FakegatoFactory);

        expect(
            makeHistoryService(api, 'weather', accessory, { log, storage: 'fs', path: '.', filename: 'h.json' }),
        ).toBeNull();
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith('Failed to load fakegato-history:', 'factory boom');
    });

    it('supports resetting the test loader', () => {
        class FirstService {
            addEntry = vi.fn();
            lastEntry = 0;
        }
        class SecondService {
            addEntry = vi.fn();
            lastEntry = 0;
        }

        const firstLoaderFactory = vi.fn((_api: API) => FirstService);
        const firstLoader = vi.fn(() => firstLoaderFactory);
        setFakegatoLoaderForTesting(firstLoader);

        const credentials1 = createCredentials();
        makeHistoryService(credentials1.api, 'weather', credentials1.accessory, {
            log: credentials1.log,
            storage: 'fs',
            path: '.',
            filename: '1.json',
        });
        expect(firstLoader).toHaveBeenCalledTimes(1);
        expect(credentials1.log.error).not.toHaveBeenCalled();

        // reset the loader and inject a new one
        setFakegatoLoaderForTesting(null);
        const secondLoaderFactory = vi.fn((_api: API) => SecondService);
        const secondLoader = vi.fn(() => secondLoaderFactory);
        setFakegatoLoaderForTesting(secondLoader);

        const credentials2 = createCredentials();
        const service = makeHistoryService(credentials2.api, 'weather', credentials2.accessory, {
            log: credentials2.log,
            storage: 'fs',
            path: '.',
            filename: '2.json',
        });
        expect(service).toBeInstanceOf(SecondService);
        expect(secondLoader).toHaveBeenCalledTimes(1);
        expect(firstLoader).toHaveBeenCalledTimes(1);
    });

    it('caches load failures, so that the loader is not called again', () => {
        const loader = vi.fn(() => null);
        setFakegatoLoaderForTesting(loader);

        expect(
            makeHistoryService(api, 'weather', accessory, { log, storage: 'fs', path: '.', filename: 'h.json' }),
        ).toBeNull();
        expect(
            makeHistoryService(api, 'weather', accessory, { log, storage: 'fs', path: '.', filename: 'h.json' }),
        ).toBeNull();
        expect(loader).toHaveBeenCalledTimes(1);
        // the error is only logged once per API instance
        expect(log.error).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(
            'Failed to load fakegato-history: the module does not export a factory function.',
        );
    });
});

describe('fakegato-history module (real module, headless)', () => {
    interface MinimalService {
        readonly UUID: string;
    }
    type MinimalServiceClass = { new (name?: string, subtype?: string): MinimalService };

    function createContractAccessory() {
        return {
            displayName: 'Real Sensor',
            services: [] as MinimalService[],
            getService(match: unknown): MinimalService | undefined {
                const targetUuid = typeof match === 'string' ? match : (match as { UUID: string }).UUID;
                return this.services.find((service) => service.UUID === targetUuid);
            },
            addService(serviceClass: MinimalServiceClass, name?: string, subtype?: string): MinimalService {
                const service = new serviceClass(name, subtype);
                this.services.push(service);
                return service;
            },
        };
    }

    let tempDir: string;
    let api: API;

    beforeAll(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'fakegato-'));
        // the module expects the hap namespace as `api.hap` and `api.user`
        api = {
            hap: hapNodejs,
            user: {
                storagePath: () => tempDir,
                persistPath: () => tempDir,
            },
        } as unknown as API;
    });

    afterAll(() => {
        // stop the module's global timer, so that vitest can exit
        (api as unknown as { globalFakeGatoTimer?: { stop?: () => void } }).globalFakeGatoTimer?.stop?.();

        rmSync(tempDir, { recursive: true, force: true });
    });

    it('registers its service on a platform accessory and accepts entries', () => {
        const accessory = createContractAccessory();
        const log = createFakeLog();
        const options: HistoryServiceOptions = {
            log,
            storage: 'fs',
            path: tempDir,
            filename: 'real-module-test.json',
        };

        let historyService: ReturnType<typeof makeHistoryService> = null;
        expect(() => {
            historyService = makeHistoryService(api, 'weather', accessory as unknown as PlatformAccessory, options);
        }).not.toThrow();

        expect(historyService).not.toBeNull();

        expect(() =>
            (historyService as NonNullable<typeof historyService>).addEntry({
                time: Math.floor(Date.now() / 1000),
                temp: 21.5,
            }),
        ).not.toThrow();

        // exactly one weather history service was registered on the accessory
        const registered = accessory.services.filter((service) => service.UUID === WEATHER_HISTORY_SERVICE_UUID);
        expect(registered).toHaveLength(1);
    });
});

describe('fakegato-history module (smoke test)', () => {
    it('resolves and exports a factory function', () => {
        const require = createRequire(import.meta.url);
        const loaded: unknown = require('fakegato-history');

        expect(typeof loaded).toBe('function');
    });
});
