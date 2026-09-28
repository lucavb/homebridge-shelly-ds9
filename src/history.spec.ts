import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as hapNodejs from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';

import { createRecorder, setFakegatoLoaderForTesting, WEATHER_HISTORY_SERVICE_UUID } from './history.ts';
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
        // never use the test loader here: this block exercises the real module
        setFakegatoLoaderForTesting(null);

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
        const accessory = createContractAccessory() as unknown as PlatformAccessory;
        const log = createFakeLog();

        const recorder = createRecorder(accessory, api, 'real-module-test', log, ['temperature']);

        expect(() => recorder.record('temperature', 21.5)).not.toThrow();

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
