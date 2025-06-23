import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeviceCache, type CachedDeviceInfo } from './device-cache';
import type { Logger } from 'homebridge';

// Mock logger
const mockLogger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
} as any;

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
            const initialInfo: CachedDeviceInfo = {
                id: 'test-device',
                model: 'ShellyPlus1',
                protocol: 'websocket',
            };

            const updatedInfo: CachedDeviceInfo = {
                id: 'test-device',
                model: 'ShellyPlus2PM',
                protocol: 'websocket',
                hostname: '192.168.1.200',
            };

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
            const mockDevice = {
                id: 'shellypro1-123456789',
                model: 'ShellyPro1',
                rpcHandler: {
                    protocol: 'websocket',
                    hostname: '192.168.1.150',
                },
            } as any;

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
            const mockDevice = {
                id: 'shelly-device',
                model: 'ShellyPlus1',
                rpcHandler: {
                    protocol: 'http',
                },
            } as any;

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
