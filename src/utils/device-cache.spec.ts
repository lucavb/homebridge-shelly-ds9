import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeviceCache, type CachedDeviceInfo } from './device-cache.ts';
import type { Logger } from 'homebridge';
import { Device } from '@lucavb/shellies-ds9';

type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> & Record<string, unknown> : T[P];
};

// Mock logger
const mockLogger: Logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
};

const buildMockDevice = (props: DeepPartial<Device>) => {
    return {
        id: 'shellypro1-123456789',
        model: 'ShellyPro1',
        rpcHandler: {
            protocol: 'websocket',
            hostname: '192.168.1.150',
        },
        ...props,
    } as unknown as Device;
};

describe('DeviceCache', () => {
    let deviceCache: DeviceCache;

    beforeEach(() => {
        deviceCache = new DeviceCache('/tmp/test', mockLogger);
    });

    describe('get() and set()', () => {
        it('should store and retrieve device info', () => {
            const deviceInfo: CachedDeviceInfo = {
                id: 'test-device-123',
                model: 'ShellyPlus1',
                protocol: 'websocket',
                hostname: '192.168.1.100',
            };

            // Set device info (without auto-save to avoid file operations)
            deviceCache.set(deviceInfo, false);

            // Retrieve device info
            const retrieved = deviceCache.get('test-device-123');

            expect(retrieved).toEqual(deviceInfo);
        });

        it('should return undefined for non-existent device', () => {
            const result = deviceCache.get('non-existent-device');
            expect(result).toBeUndefined();
        });

        it('should overwrite existing device info', () => {
            const initialInfo = {
                id: 'test-device',
                model: 'ShellyPlus1',
                protocol: 'websocket',
            } as const satisfies CachedDeviceInfo;

            const updatedInfo = {
                id: 'test-device',
                model: 'ShellyPlus2PM',
                protocol: 'websocket',
                hostname: '192.168.1.200',
            } as const satisfies CachedDeviceInfo;

            deviceCache.set(initialInfo, false);
            deviceCache.set(updatedInfo, false);

            const result = deviceCache.get('test-device');
            expect(result).toEqual(updatedInfo);
        });
    });

    describe('delete()', () => {
        it('should remove device from cache', () => {
            const deviceInfo: CachedDeviceInfo = {
                id: 'test-device',
                model: 'ShellyPlus1',
                protocol: 'websocket',
            };

            // Add device
            deviceCache.set(deviceInfo, false);
            expect(deviceCache.get('test-device')).toEqual(deviceInfo);

            // Delete device
            deviceCache.delete('test-device', false);
            expect(deviceCache.get('test-device')).toBeUndefined();
        });

        it('should handle deleting non-existent device gracefully', () => {
            // Should not throw
            expect(() => deviceCache.delete('non-existent', false)).not.toThrow();
        });
    });

    describe('storeDevice()', () => {
        it('should extract device info correctly', () => {
            const mockDevice = buildMockDevice({
                rpcHandler: { protocol: 'websocket', hostname: '192.168.1.150' },
            });

            deviceCache.storeDevice(mockDevice, false);

            const stored = deviceCache.get('shellypro1-123456789');
            expect(stored).toEqual({
                id: 'shellypro1-123456789',
                model: 'ShellyPro1',
                protocol: 'websocket',
                hostname: '192.168.1.150',
            });
        });

        it('should handle device without hostname', () => {
            const mockDevice = buildMockDevice({
                id: 'shelly-device',
                model: 'ShellyPlus1',
                rpcHandler: { protocol: 'http' },
            });

            deviceCache.storeDevice(mockDevice, false);

            const stored = deviceCache.get('shelly-device');
            expect(stored).toEqual({
                id: 'shelly-device',
                model: 'ShellyPlus1',
                protocol: 'http',
                hostname: undefined,
            });
        });
    });

    describe('load()', () => {
        let tempDir: string;

        beforeEach(async () => {
            tempDir = await mkdtemp(join(tmpdir(), 'device-cache-test-'));
        });

        afterEach(async () => {
            await fs.rm(tempDir, { recursive: true, force: true });
        });

        it('should load devices from the legacy cache file and migrate on save', async () => {
            const legacyPath = join(tempDir, '.shelly-ng.json');
            const cachePath = join(tempDir, '.shelly-ds9.json');
            const deviceInfo: CachedDeviceInfo = {
                id: 'shellyplus1-legacy123',
                model: 'ShellyPlus1',
                protocol: 'websocket',
                hostname: '192.168.1.50',
            };

            await fs.writeFile(legacyPath, JSON.stringify({ devices: [deviceInfo] }));

            const cache = new DeviceCache(tempDir, mockLogger);
            await cache.load();

            expect(cache.get('shellyplus1-legacy123')).toEqual(deviceInfo);

            await new Promise((resolve) => setTimeout(resolve, 1100));

            await expect(fs.access(cachePath)).resolves.toBeUndefined();
            const migrated = JSON.parse(await fs.readFile(cachePath, { encoding: 'utf8' })) as {
                devices: CachedDeviceInfo[];
            };
            expect(migrated.devices).toEqual([deviceInfo]);
        });
    });

    describe('iterator', () => {
        it('should iterate over stored devices', () => {
            const devices: CachedDeviceInfo[] = [
                { id: 'device1', model: 'Model1', protocol: 'websocket' },
                { id: 'device2', model: 'Model2', protocol: 'websocket' },
                { id: 'device3', model: 'Model3', protocol: 'websocket' },
            ];

            devices.forEach((device) => deviceCache.set(device, false));

            const iteratedDevices = Array.from(deviceCache);
            expect(iteratedDevices).toHaveLength(3);
            expect(iteratedDevices).toEqual(expect.arrayContaining(devices));
        });

        it('should return empty iterator for empty cache', () => {
            const iteratedDevices = Array.from(deviceCache);
            expect(iteratedDevices).toHaveLength(0);
        });
    });
});
