import EventEmitter from 'eventemitter3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { RGB } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { ShellyPlatform } from '../platform.ts';
import { DeviceLogger } from '../utils/device-logger.ts';
import { hsvToRgb, RGBLightAbility, rgbToHsv } from './rgb-light.ts';

function createRGBComponent(
    rgb: [number, number, number] | undefined = [255, 0, 0],
    output: boolean | undefined = true,
    brightness: number | undefined = 80,
): RGB {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
        id: 0,
        key: 'rgb:0',
        config: {},
        output,
        brightness,
        rgb,
        set: vi.fn().mockResolvedValue({ was_on: true }),
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        emit: emitter.emit.bind(emitter),
    }) as unknown as RGB;
}

function setupAbility(component: RGB) {
    const ability = new RGBLightAbility(component);
    const platform = {
        log: { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        api: { hap: { uuid, Characteristic, Service, HAPStatus, HapStatusError } },
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
    const platformAccessory = {
        addService: (serviceClass: typeof Service.Lightbulb, name?: string, subtype?: string) =>
            new serviceClass(name, subtype),
        getService: () => undefined,
        getServiceById: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;
    const log = new DeviceLogger({ id: 'shelly-plus-rgbw-pm-test' } as never, 'Test Device', platform.log);
    ability.setup(platformAccessory, platform, log);

    return { ability, service: ability['service'] };
}

describe('RGB colour conversion', () => {
    it.each([
        [
            [255, 0, 0],
            [0, 100, 100],
        ],
        [
            [0, 255, 0],
            [120, 100, 100],
        ],
        [
            [0, 0, 255],
            [240, 100, 100],
        ],
        [
            [255, 255, 255],
            [0, 0, 100],
        ],
        [
            [0, 0, 0],
            [0, 0, 0],
        ],
    ])('converts %j RGB to %j HSV', (rgb, hsv) => {
        expect(rgbToHsv(rgb as [number, number, number])).toEqual(hsv);
    });

    it('converts HSV back to integer RGB channels', () => {
        expect(hsvToRgb(120, 100, 100)).toEqual([0, 255, 0]);
        expect(hsvToRgb(360, 100, 100)).toEqual([255, 0, 0]);
        expect(hsvToRgb(240, 0, 50)).toEqual([128, 128, 128]);
    });
});

describe('RGBLightAbility', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('seeds the initial HomeKit On and Brightness values from the already-loaded component status', () => {
        const { ability, service } = setupAbility(createRGBComponent());

        expect(service.getCharacteristic(Characteristic.On).value).toBe(true);
        expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(80);
        ability.detach();
    });

    it('leaves the HomeKit On and Brightness defaults intact when the device has not reported them', () => {
        const component = createRGBComponent();
        (component as unknown as { output?: boolean }).output = undefined;
        (component as unknown as { brightness?: number }).brightness = undefined;
        const { ability, service } = setupAbility(component);
        // HAP's defaults are false and 0; fabricated seeding (e.g. `?? false` /
        // `?? 100`) must fail here.
        expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
        expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(0);

        component.emit('change:output', undefined);
        component.emit('change:brightness', undefined);
        expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
        expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(0);
        ability.detach();
    });

    it('leaves the HomeKit Brightness default intact when brightness is not finite', () => {
        const component = createRGBComponent(undefined, true, Number.NaN);
        const { ability, service } = setupAbility(component);

        expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(0);
        ability.detach();
    });

    it('drops an On write that does not carry a boolean value', async () => {
        const component = createRGBComponent();
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            onSetHandler(value: unknown): Promise<void>;
        };

        await expect(handlers.onSetHandler('off')).resolves.toBeUndefined();
        expect(component.set).not.toHaveBeenCalled();
        ability.detach();
    });

    it('drops a Brightness write that does not carry a finite number', async () => {
        const component = createRGBComponent();
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            brightnessSetHandler(value: unknown): Promise<void>;
        };

        await expect(handlers.brightnessSetHandler('45')).resolves.toBeUndefined();
        await expect(handlers.brightnessSetHandler(Number.NaN)).resolves.toBeUndefined();
        expect(component.set).not.toHaveBeenCalled();
        ability.detach();
    });

    it('drops non-boolean output change events', () => {
        const component = createRGBComponent();
        const { ability, service } = setupAbility(component);
        const on = service.getCharacteristic(Characteristic.On);

        component.emit('change:output', 'off');
        expect(on.value).toBe(true);

        ability.detach();
    });

    it('drops non-numeric or non-finite brightness change events', () => {
        const component = createRGBComponent();
        const { ability, service } = setupAbility(component);
        const brightness = service.getCharacteristic(Characteristic.Brightness);

        component.emit('change:brightness', '25');
        expect(brightness.value).toBe(80);

        component.emit('change:brightness', Number.NaN);
        expect(brightness.value).toBe(80);

        ability.detach();
    });

    it('ignores rgb change events whose channels are not all finite numbers', () => {
        const component = createRGBComponent([255, 0, 0]);
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);
        const saturation = service.getCharacteristic(Characteristic.Saturation);

        // NaN channel, non-numeric entries, and channel values that would be
        // silently coerced to numbers (e.g. `Number(true)` === 1) must not
        // propagate into Hue/Saturation.
        component.emit('change:rgb', [255, NaN, 0]);
        component.emit('change:rgb', ['0', '0', '255']);
        component.emit('change:rgb', [true, false, 255]);

        expect(hue.value).toBe(0);
        expect(saturation.value).toBe(100);
        ability.detach();
    });

    it('ignores rgb change events that do not carry three channels', () => {
        const component = createRGBComponent([255, 0, 0]);
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);
        const saturation = service.getCharacteristic(Characteristic.Saturation);

        component.emit('change:rgb', [0, 0, 255, 0]);
        component.emit('change:rgb', 'not-an-array');

        expect(hue.value).toBe(0);
        expect(saturation.value).toBe(100);
        ability.detach();
    });

    it('maps on and brightness commands to RGB RPC parameters', async () => {
        const component = createRGBComponent();
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            onSetHandler(value: boolean): Promise<void>;
            brightnessSetHandler(value: number): Promise<void>;
        };

        await handlers.onSetHandler(false);
        await handlers.brightnessSetHandler(45);

        expect(component.set).toHaveBeenNthCalledWith(1, { on: false });
        expect(component.set).toHaveBeenNthCalledWith(2, { brightness: 45 });
        ability.detach();
    });

    it('maps hue and saturation independently while preserving the other colour dimension', async () => {
        const component = createRGBComponent([255, 0, 0]);
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            hueSetHandler(value: number): Promise<void>;
            saturationSetHandler(value: number): Promise<void>;
        };

        await handlers.hueSetHandler(120);
        expect(component.set).toHaveBeenLastCalledWith({ rgb: [0, 255, 0] });
        await handlers.saturationSetHandler(50);
        expect(component.set).toHaveBeenLastCalledWith({ rgb: [128, 255, 128] });
        ability.detach();
    });

    it('preserves a hue selected while the initial color is white for a later saturation write', async () => {
        const component = createRGBComponent([255, 255, 255]);
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            hueSetHandler(value: number): Promise<void>;
            saturationSetHandler(value: number): Promise<void>;
        };

        await handlers.hueSetHandler(120);
        expect(component.set).toHaveBeenLastCalledWith({ rgb: [255, 255, 255] });
        await handlers.saturationSetHandler(100);
        expect(component.set).toHaveBeenLastCalledWith({ rgb: [0, 255, 0] });
        ability.detach();
    });

    it('sets a chromatic color from black without changing the separate Shelly brightness', async () => {
        const component = createRGBComponent([0, 0, 0]);
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            hueSetHandler(value: number): Promise<void>;
            saturationSetHandler(value: number): Promise<void>;
        };

        await handlers.hueSetHandler(120);
        await handlers.saturationSetHandler(100);

        expect(component.set).toHaveBeenNthCalledWith(1, { rgb: [255, 255, 255] });
        expect(component.set).toHaveBeenNthCalledWith(2, { rgb: [0, 255, 0] });
        expect(component.brightness).toBe(80);
        expect(component.set).not.toHaveBeenCalledWith({ brightness: expect.anything() });
        ability.detach();
    });

    it('preserves the selected hue through black and white device updates', async () => {
        const component = createRGBComponent([255, 255, 255]);
        const { ability, service } = setupAbility(component);
        const handlers = ability as unknown as {
            hueSetHandler(value: number): Promise<void>;
            saturationSetHandler(value: number): Promise<void>;
        };

        await handlers.hueSetHandler(240);
        component.emit('change:rgb', [0, 0, 0]);
        component.emit('change:rgb', [255, 255, 255]);
        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(240);
        expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(0);

        await handlers.saturationSetHandler(100);
        expect(component.set).toHaveBeenLastCalledWith({ rgb: [0, 0, 255] });
        ability.detach();
    });

    it('serializes simultaneous hue and saturation writes using the latest desired state', async () => {
        const component = createRGBComponent([255, 255, 255]);
        let resolveFirst!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValue({ was_on: true }) as unknown as RGB['set'];
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            hueSetHandler(value: number): Promise<void>;
            saturationSetHandler(value: number): Promise<void>;
        };

        const hueWrite = handlers.hueSetHandler(120);
        const saturationWrite = handlers.saturationSetHandler(100);
        await Promise.resolve();
        expect(component.set).toHaveBeenCalledTimes(1);
        expect(component.set).toHaveBeenNthCalledWith(1, { rgb: [255, 255, 255] });

        resolveFirst({ was_on: true });
        await Promise.all([hueWrite, saturationWrite]);
        expect(component.set).toHaveBeenNthCalledWith(2, { rgb: [0, 255, 0] });
        ability.detach();
    });

    it('does not drain queued color writes after the ability is detached and reactivated', async () => {
        const component = createRGBComponent([255, 255, 255]);
        let resolveFirst!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValue({ was_on: true }) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);
        const saturation = service.getCharacteristic(Characteristic.Saturation);

        const firstWrite = hue.handleSetRequest(120, undefined, undefined);
        const queuedWrite = saturation.handleSetRequest(100, undefined, undefined);
        await Promise.resolve();
        expect(component.set).toHaveBeenCalledTimes(1);

        ability.active = false;
        ability.active = true;
        resolveFirst({ was_on: true });

        await firstWrite;
        await expect(queuedWrite).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(component.set).toHaveBeenCalledTimes(1);
        ability.detach();
    });

    it('keeps reconciled color after Hue writeback and accepts later changes matching an earlier target', async () => {
        const component = createRGBComponent([255, 0, 0]);
        let resolveFirst!: (value: { was_on: boolean }) => void;
        let resolveFinal!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFinal = resolve))) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        const firstWrite = hue.handleSetRequest(60, undefined, undefined);
        const finalWrite = hue.handleSetRequest(120, undefined, undefined);
        await Promise.resolve();
        resolveFirst({ was_on: true });
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(2));

        // The device reports a different authoritative color while the final
        // command is still pending.
        (component as unknown as { rgb: [number, number, number] }).rgb = [0, 0, 255];
        component.emit('change:rgb', [0, 0, 255]);
        resolveFinal({ was_on: true });
        await Promise.all([firstWrite, finalWrite]);

        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(240);
        expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(100);

        // A legitimate later change matching the earlier command is not
        // distinguishable from a delayed echo by RGB value alone.
        (component as unknown as { rgb: [number, number, number] }).rgb = [255, 255, 0];
        component.emit('change:rgb', [255, 255, 0]);
        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(60);
        ability.detach();
    });

    it('does not reconcile an earlier notification after a later queued color command succeeds silently', async () => {
        const component = createRGBComponent([255, 0, 0]);
        let resolveFirst!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValue({ was_on: true }) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        const firstWrite = hue.handleSetRequest(60, undefined, undefined);
        const finalWrite = hue.handleSetRequest(120, undefined, undefined);
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(1));

        (component as unknown as { rgb: [number, number, number] }).rgb = [0, 0, 255];
        component.emit('change:rgb', [0, 0, 255]);
        resolveFirst({ was_on: true });
        await Promise.all([firstWrite, finalWrite]);

        expect(component.set).toHaveBeenNthCalledWith(2, { rgb: [0, 255, 0] });
        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(120);
        ability.detach();
    });

    it('reconciles an external return to the starting RGB notified during a pending write', async () => {
        const component = createRGBComponent([255, 0, 0]);
        let resolveWrite!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveWrite = resolve))) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        const write = hue.handleSetRequest(120, undefined, undefined);
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(1));
        (component as unknown as { rgb: [number, number, number] }).rgb = [255, 0, 0];
        component.emit('change:rgb', [255, 0, 0]);
        resolveWrite({ was_on: true });
        await write;

        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(0);
        ability.detach();
    });

    it('keeps desired color when the component RGB did not change and no notification arrived', async () => {
        const component = createRGBComponent([255, 0, 0]);
        const { ability, service } = setupAbility(component);

        await service.getCharacteristic(Characteristic.Hue).handleSetRequest(120, undefined, undefined);

        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(120);
        ability.detach();
    });

    it('updates HomeKit color characteristics for an immediate device RGB change', () => {
        const component = createRGBComponent([255, 0, 0]);
        const { ability, service } = setupAbility(component);

        (component as unknown as { rgb: [number, number, number] }).rgb = [0, 0, 255];
        component.emit('change:rgb', [0, 0, 255]);

        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(240);
        expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(100);
        ability.detach();
    });

    it('keeps a device update authoritative when it arrives after RPC settle but before HAP writeback', async () => {
        const component = createRGBComponent([255, 0, 0]);
        let resolveWrite!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveWrite = resolve))) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        const write = hue.handleSetRequest(120, undefined, undefined);
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(1));

        resolveWrite({ was_on: true });
        // Wait until the RPC queue is settled, then deliver the device status
        // before HAP's setter continuation writes back its requested Hue.
        await new Promise<void>((resolve) => {
            const deliverWhenQueueSettles = () => {
                if ((ability as unknown as { pendingColorWrites: number }).pendingColorWrites === 0) {
                    (component as unknown as { rgb: [number, number, number] }).rgb = [0, 0, 255];
                    component.emit('change:rgb', [0, 0, 255]);
                    resolve();
                    return;
                }
                queueMicrotask(deliverWhenQueueSettles);
            };
            queueMicrotask(deliverWhenQueueSettles);
        });

        await write;
        expect(hue.value).toBe(240);
        await expect(hue.handleGetRequest(undefined, undefined)).resolves.toBe(240);
        ability.detach();
    });

    it('reconciles a prior device notification when a later queued color RPC fails', async () => {
        const component = createRGBComponent([255, 0, 0]);
        let resolveFirst!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockRejectedValueOnce(new Error('second color RPC failed')) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        const firstWrite = hue.handleSetRequest(60, undefined, undefined);
        const failedWrite = hue.handleSetRequest(120, undefined, undefined);
        const failure = expect(failedWrite).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(1));
        (component as unknown as { rgb: [number, number, number] }).rgb = [0, 0, 255];
        component.emit('change:rgb', [0, 0, 255]);
        resolveFirst({ was_on: true });

        await firstWrite;
        await failure;
        expect(hue.value).toBe(240);
        ability.detach();
    });

    it('prefers a newer device notification over an earlier one when a later color RPC fails', async () => {
        const component = createRGBComponent([255, 0, 0]);
        let resolveFirst!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockRejectedValueOnce(new Error('second color RPC failed')) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        const firstWrite = hue.handleSetRequest(60, undefined, undefined);
        const failedWrite = hue.handleSetRequest(120, undefined, undefined);
        const failure = expect(failedWrite).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(1));
        (component as unknown as { rgb: [number, number, number] }).rgb = [0, 0, 255];
        component.emit('change:rgb', [0, 0, 255]);
        resolveFirst({ was_on: true });
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(2));

        (component as unknown as { rgb: [number, number, number] }).rgb = [0, 255, 0];
        component.emit('change:rgb', [0, 255, 0]);
        await firstWrite;
        await failure;

        expect(hue.value).toBe(120);
        ability.detach();
    });

    it('settles to the last successful HAP color command when the final queued RPC fails', async () => {
        const component = createRGBComponent([255, 0, 0]);
        let resolveFirst!: (value: { was_on: boolean }) => void;
        component.set = vi
            .fn()
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockRejectedValueOnce(new Error('second color RPC failed')) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        const firstWrite = hue.handleSetRequest(60, undefined, undefined);
        const failedWrite = hue.handleSetRequest(120, undefined, undefined);
        const failure = expect(failedWrite).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(1));
        resolveFirst({ was_on: true });
        await vi.waitFor(() => expect(component.set).toHaveBeenCalledTimes(2));

        await firstWrite;
        await failure;
        expect(hue.value).toBe(60);
        await expect(hue.handleGetRequest(undefined, undefined)).resolves.toBe(60);
        ability.detach();
    });

    it('does not expose a failed single color request as the current HAP color', async () => {
        const component = createRGBComponent([255, 0, 0]);
        component.set = vi.fn().mockRejectedValue(new Error('color RPC failed')) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        await expect(hue.handleSetRequest(120, undefined, undefined)).rejects.toBe(
            HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );

        expect(hue.value).toBe(0);
        await expect(hue.handleGetRequest(undefined, undefined)).resolves.toBe(0);
        ability.detach();
    });

    it('confirms an explicitly selected hue when a successful write is echoed as achromatic RGB', async () => {
        const component = createRGBComponent([0, 0, 0]);
        component.set = vi.fn().mockImplementation(async (params: { rgb?: [number, number, number] }) => {
            if (params.rgb) {
                (component as unknown as { rgb: [number, number, number] }).rgb = params.rgb;
                component.emit('change:rgb', params.rgb);
            }
            return { was_on: true };
        }) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        await hue.handleSetRequest(120, undefined, undefined);

        expect(hue.value).toBe(120);
        await expect(hue.handleGetRequest(undefined, undefined)).resolves.toBe(120);
        expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(0);
        ability.detach();
    });

    it('reactivates with the confirmed color rather than a failed request intent', async () => {
        const component = createRGBComponent([255, 0, 0]);
        component.set = vi
            .fn()
            .mockRejectedValueOnce(new Error('color RPC failed'))
            .mockResolvedValue({ was_on: true }) as unknown as RGB['set'];
        const { ability, service } = setupAbility(component);
        const hue = service.getCharacteristic(Characteristic.Hue);

        await expect(hue.handleSetRequest(120, undefined, undefined)).rejects.toBe(
            HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
        expect(await hue.handleGetRequest(undefined, undefined)).toBe(0);

        ability.active = false;
        ability.active = true;
        const activeService = (ability as unknown as { service: Service }).service;
        const activeHue = activeService.getCharacteristic(Characteristic.Hue);
        expect(activeHue.value).toBe(0);
        await expect(activeHue.handleGetRequest(undefined, undefined)).resolves.toBe(0);
        ability.detach();
    });

    it('keeps desired hue after an RPC failure so a later write or retry uses it', async () => {
        const component = createRGBComponent([255, 255, 255]);
        component.set = vi
            .fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValue({ was_on: true }) as unknown as RGB['set'];
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as {
            hueSetHandler(value: number): Promise<void>;
            saturationSetHandler(value: number): Promise<void>;
        };

        await expect(handlers.hueSetHandler(120)).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        await handlers.hueSetHandler(120);
        await handlers.saturationSetHandler(50);

        expect(component.set).toHaveBeenNthCalledWith(2, { rgb: [255, 255, 255] });
        expect(component.set).toHaveBeenNthCalledWith(3, { rgb: [128, 255, 128] });
        ability.detach();
    });

    it('updates on and brightness from device events and removes every component listener on detach', () => {
        const component = createRGBComponent();
        const offSpy = vi.spyOn(component, 'off');
        const { ability, service } = setupAbility(component);

        component.emit('change:output', false);
        component.emit('change:brightness', 25);
        expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
        expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(25);

        ability.detach();
        expect(offSpy).toHaveBeenCalledWith('change:output', expect.any(Function), ability);
        expect(offSpy).toHaveBeenCalledWith('change:brightness', expect.any(Function), ability);
        expect(offSpy).toHaveBeenCalledWith('change:rgb', expect.any(Function), ability);
    });

    it('translates device failures into HomeKit communication errors', async () => {
        const component = createRGBComponent();
        component.set = vi.fn().mockRejectedValue(new Error('RPC failed')) as unknown as RGB['set'];
        const { ability } = setupAbility(component);

        await expect(
            (ability as unknown as { onSetHandler(value: boolean): Promise<void> }).onSetHandler(false),
        ).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        ability.detach();
    });

    it('rejects HomeKit commands after its component becomes stale', async () => {
        const component = createRGBComponent();
        const { ability } = setupAbility(component);
        const handlers = ability as unknown as { onSetHandler(value: boolean): Promise<void> };

        ability.markStale();

        await expect(handlers.onSetHandler(true)).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        expect(component.set).not.toHaveBeenCalled();
        ability.detach();
    });
});
