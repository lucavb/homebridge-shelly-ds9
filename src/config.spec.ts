import { describe, it, expect } from 'vitest';
import { PlatformOptions } from './config';
import type { PlatformConfig } from 'homebridge';

describe('PlatformOptions', () => {
    describe('constructor', () => {
        it('should use default values for empty config', () => {
            const config: PlatformConfig = { platform: 'ShellyNG' };
            const options = new PlatformOptions(config);

            expect(options.mdns.enable).toBe(true);
            expect(options.websocket.requestTimeout).toBe(10);
            expect(options.websocket.pingInterval).toBe(60);
            expect(options.websocket.reconnectInterval).toEqual([5, 10, 30, 60, 300, 600]);
        });

        it('should merge custom mDNS options with defaults', () => {
            const config: PlatformConfig = {
                platform: 'ShellyNG',
                mdns: {
                    enable: false,
                    interface: 'eth0',
                },
            };
            const options = new PlatformOptions(config);

            expect(options.mdns.enable).toBe(false);
            expect(options.mdns.interface).toBe('eth0');
        });

        it('should handle websocket.reconnectInterval as comma-separated string', () => {
            const config: PlatformConfig = {
                platform: 'ShellyNG',
                websocket: {
                    reconnectInterval: '1,2,5,10',
                },
            };
            const options = new PlatformOptions(config);

            expect(options.websocket.reconnectInterval).toEqual([1, 2, 5, 10]);
        });

        it('should parse device configuration', () => {
            const config: PlatformConfig = {
                platform: 'ShellyNG',
                devices: [
                    {
                        id: 'shellyplus1-abcd1234',
                        name: 'Living Room Switch',
                        hostname: '192.168.1.100',
                        password: 'secret123',
                    },
                    {
                        id: 'shellypro2pm-xyz789',
                        exclude: true,
                    },
                ],
            };
            const options = new PlatformOptions(config);

            const device1 = options.getDeviceOptions('shellyplus1-abcd1234');
            expect(device1.name).toBe('Living Room Switch');
            expect(device1.hostname).toBe('192.168.1.100');
            expect(device1.password).toBe('secret123');
            expect(device1.exclude).toBe(false); // default value
            expect(device1.protocol).toBe('websocket'); // default value

            const device2 = options.getDeviceOptions('shellypro2pm-xyz789');
            expect(device2.exclude).toBe(true);
        });

        it('should normalize device IDs to lowercase', () => {
            const config: PlatformConfig = {
                platform: 'ShellyNG',
                devices: [
                    {
                        id: 'ShellyPlus1-ABCD1234',
                        name: 'Test Device',
                    },
                ],
            };
            const options = new PlatformOptions(config);

            // Should be accessible with lowercase ID
            const device = options.getDeviceOptions('shellyplus1-abcd1234');
            expect(device.name).toBe('Test Device');
        });
    });

    describe('getDeviceOptions()', () => {
        it('should return default options for unknown device', () => {
            const config: PlatformConfig = { platform: 'ShellyNG' };
            const options = new PlatformOptions(config);

            const device = options.getDeviceOptions('unknown-device');
            expect(device.exclude).toBe(false);
            expect(device.protocol).toBe('websocket');
            expect(device.name).toBeUndefined();
            expect(device.hostname).toBeUndefined();
        });

        it('should handle switch-specific options', () => {
            const config: PlatformConfig = {
                platform: 'ShellyNG',
                devices: [
                    {
                        id: 'shellypro4pm-test',
                        'switch:0': { type: 'outlet', exclude: false },
                        'switch:1': { type: 'switch', exclude: true },
                    },
                ],
            };
            const options = new PlatformOptions(config);

            const device = options.getDeviceOptions('shellypro4pm-test');
            expect(device['switch:0']?.type).toBe('outlet');
            expect(device['switch:0']?.exclude).toBe(false);
            expect(device['switch:1']?.type).toBe('switch');
            expect(device['switch:1']?.exclude).toBe(true);
        });
    });
});
