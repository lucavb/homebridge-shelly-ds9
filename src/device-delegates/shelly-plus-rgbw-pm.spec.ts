import EventEmitter from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellyPlusRGBWPM } from '@lucavb/shellies-ds9';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';

import '../platform.ts';
import type { ShellyPlatform } from '../platform.ts';
import { DeviceDelegate } from './base.ts';
import { ShellyPlusRGBWPmDelegate } from './shelly-plus-rgbw-pm.ts';

function component(key: string, id: number) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
        key,
        id,
        config: {},
        output: false,
        brightness: 50,
        rgb: [255, 255, 255],
        set: vi.fn().mockResolvedValue({ was_on: false }),
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        emit: emitter.emit.bind(emitter),
    });
}

function createDelegate(
    profile: 'rgb' | 'rgbw' | 'light' | 'unknown' | 'incomplete',
    config: Record<string, unknown> = {},
    cachedAccessoryIds: string[] = [],
) {
    const rpcHandler = Object.assign(new EventEmitter(), { connected: true });
    const components = new Map<string, ReturnType<typeof component>>();
    const props =
        profile === 'rgb'
            ? { rgb: component('rgb:0', 0) }
            : profile === 'rgbw'
              ? { rgbw: component('rgbw:0', 0) }
              : profile === 'light'
                ? {
                      light0: component('light:0', 0),
                      light1: component('light:1', 1),
                      light2: component('light:2', 2),
                      light3: component('light:3', 3),
                  }
                : profile === 'incomplete'
                  ? {
                        light0: component('light:0', 0),
                        light1: component('light:1', 1),
                        light2: component('light:2', 2),
                    }
                  : {};
    for (const item of Object.values(props)) {
        components.set(item.key, item);
    }

    const device = Object.assign(new EventEmitter(), {
        id: 'shelly-plus-rgbw-pm-test',
        macAddress: '00:00:00:00:00:01',
        modelName: 'Shelly Plus RGBW PM',
        profile,
        rpcHandler,
        ...props,
        getComponent: (key: string) => components.get(key),
        [Symbol.iterator]: function* () {
            yield* components.entries();
        },
    });
    const logger = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cached = new Map(
        cachedAccessoryIds.map((id) => {
            const UUID = uuid.generate(`shelly-plus-rgbw-pm-test-${id}`);
            return [UUID, { UUID } as PlatformAccessory];
        }),
    );
    const platform = {
        log: logger,
        api: { hap: { uuid, Characteristic, Service, HAPStatus, HapStatusError } },
        customCharacteristics: {},
        customServices: {},
        getAccessory: vi.fn((id: string) => cached.get(id)),
        addAccessory: vi.fn(),
        removeAccessory: vi.fn((...items: PlatformAccessory[]) => {
            for (const item of items) {
                cached.delete(item.UUID);
            }
        }),
    };

    const delegate = new ShellyPlusRGBWPmDelegate(
        device as unknown as ShellyPlusRGBWPM,
        { name: 'Test', ...config } as never,
        platform as never,
    );

    return { delegate, device, components, logger, rpcHandler, platform };
}

function accessories(delegate: ShellyPlusRGBWPmDelegate) {
    return (delegate as unknown as { accessories: Map<string, { active: boolean; abilities: unknown[] }> }).accessories;
}

function setupAbility(
    ability: { setup(...args: never[]): void },
    platform: object,
    delegate: ShellyPlusRGBWPmDelegate,
) {
    const platformAccessory = {
        addService: (serviceClass: typeof Service.Lightbulb, name?: string, subtype?: string) =>
            new serviceClass(name, subtype),
        getService: () => undefined,
        getServiceById: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;
    (ability.setup as (...args: unknown[]) => void)(platformAccessory, platform as ShellyPlatform, delegate.log);
}

describe('ShellyPlusRGBWPmDelegate', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('registers the Shelly Plus RGBW PM delegate', () => {
        expect(DeviceDelegate.getDelegate('SNDC-0D4P10WW')).toBe(ShellyPlusRGBWPmDelegate);
    });

    it.each(['rgb', 'rgbw'] as const)(
        'uses the stable single-light identity for the %s profile and honors exclusion',
        (profile) => {
            vi.useFakeTimers();
            const componentKey = profile === 'rgb' ? 'rgb:0' : 'rgbw:0';
            const { delegate } = createDelegate(profile, { [componentKey]: { exclude: true } });

            expect([...accessories(delegate).keys()]).toEqual(['light']);
            expect(accessories(delegate).get('light')?.active).toBe(false);
            delegate.detach();
        },
    );

    it('uses addLight identities and per-component exclusions for the four-light profile', () => {
        vi.useFakeTimers();
        const { delegate } = createDelegate('light', {
            'light:0': { exclude: true },
            'light:1': { exclude: true },
            'light:2': { exclude: true },
            'light:3': { exclude: true },
        });

        expect([...accessories(delegate).keys()]).toEqual(['light-0', 'light-1', 'light-2', 'light-3']);
        expect(accessories(delegate).get('light-0')?.active).toBe(false);
        expect(accessories(delegate).get('light-1')?.active).toBe(false);
        expect(accessories(delegate).get('light-2')?.active).toBe(false);
        expect(accessories(delegate).get('light-3')?.active).toBe(false);
        delegate.detach();
    });

    it('constructs the stale-aware light ability directly in addLight for the four-light profile', () => {
        vi.useFakeTimers();
        const { delegate } = createDelegate('light');

        const abilityNames = [...accessories(delegate).values()].map(
            (accessory) => (accessory.abilities[1] as { constructor: { name: string } }).constructor.name,
        );
        expect(abilityNames).toEqual(
            ['light-0', 'light-1', 'light-2', 'light-3'].map(() => 'RestartAwareLightAbility'),
        );
        delegate.detach();
    });

    it('prunes only this device’s cached four-light identities after observing RGB topology', () => {
        vi.useFakeTimers();
        const cachedIds = ['light', 'light-0', 'light-1', 'light-2', 'light-3', 'unrelated'];
        const { delegate, platform } = createDelegate('rgb', { 'rgb:0': { exclude: true } }, cachedIds);

        expect(platform.removeAccessory).toHaveBeenCalledTimes(4);
        for (const id of [0, 1, 2, 3]) {
            expect(platform.removeAccessory).toHaveBeenCalledWith(
                expect.objectContaining({ UUID: uuid.generate(`shelly-plus-rgbw-pm-test-light-${id}`) }),
            );
        }
        expect(platform.removeAccessory).not.toHaveBeenCalledWith(
            expect.objectContaining({ UUID: uuid.generate('shelly-plus-rgbw-pm-test-light') }),
        );
        expect(platform.removeAccessory).not.toHaveBeenCalledWith(
            expect.objectContaining({ UUID: uuid.generate('shelly-plus-rgbw-pm-test-unrelated') }),
        );
        delegate.detach();
    });

    it('prunes only the cached single-light identity after observing complete four-light topology', () => {
        vi.useFakeTimers();
        const cachedIds = ['light', 'light-0', 'light-1', 'light-2', 'light-3', 'unrelated'];
        const config = Object.fromEntries([0, 1, 2, 3].map((id) => [`light:${id}`, { exclude: true }]));
        const { delegate, platform } = createDelegate('light', config, cachedIds);

        expect(platform.removeAccessory).toHaveBeenCalledTimes(1);
        expect(platform.removeAccessory).toHaveBeenCalledWith(
            expect.objectContaining({ UUID: uuid.generate('shelly-plus-rgbw-pm-test-light') }),
        );
        for (const id of [0, 1, 2, 3]) {
            expect(platform.removeAccessory).not.toHaveBeenCalledWith(
                expect.objectContaining({ UUID: uuid.generate(`shelly-plus-rgbw-pm-test-light-${id}`) }),
            );
        }
        expect(platform.removeAccessory).not.toHaveBeenCalledWith(
            expect.objectContaining({ UUID: uuid.generate('shelly-plus-rgbw-pm-test-unrelated') }),
        );
        delegate.detach();
    });

    it.each(['unknown', 'incomplete'] as const)('does not prune cached accessories for %s topology', (profile) => {
        vi.useFakeTimers();
        const config = Object.fromEntries([0, 1, 2].map((id) => [`light:${id}`, { exclude: true }]));
        const { delegate, platform } = createDelegate(profile, config, [
            'light',
            'light-0',
            'light-1',
            'light-2',
            'light-3',
        ]);

        expect(platform.removeAccessory).not.toHaveBeenCalled();
        delegate.detach();
    });

    it('detaches listeners from removed profile components and requires restart on profile change', async () => {
        vi.useFakeTimers();
        const { delegate, components, logger, rpcHandler, platform } = createDelegate('rgb');
        const oldComponent = components.get('rgb:0')!;
        const firstAccessory = accessories(delegate).get('light')!;
        const rgbAbility = firstAccessory.abilities[1] as { component?: unknown; detach(): void };
        expect(rgbAbility.component).toBe(oldComponent);
        setupAbility(rgbAbility as never, platform, delegate);
        const detach = vi.spyOn(rgbAbility, 'detach');
        const markStale = vi.spyOn(rgbAbility as typeof rgbAbility & { markStale(): void }, 'markStale');
        expect(rpcHandler.listeners('statusUpdate')).toHaveLength(1);
        const newComponent = component('rgb:0', 0);
        components.set('rgb:0', newComponent);

        rpcHandler.emit('statusUpdate', {});

        expect(rpcHandler.listeners('statusUpdate')).toHaveLength(0);
        expect(detach).toHaveBeenCalledOnce();
        expect(markStale).toHaveBeenCalledOnce();
        expect(logger.log).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('Lighting profile changed; restart Homebridge to apply the new profile'),
        );
        await expect(
            (rgbAbility as unknown as { onSetHandler(value: boolean): Promise<void> }).onSetHandler(true),
        ).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        delegate.detach();
    });

    it('guards onSet callbacks for the existing addLight profile after a profile switch', async () => {
        vi.useFakeTimers();
        const options = Object.fromEntries([0, 1, 2, 3].map((id) => [`light:${id}`, { exclude: true }]));
        const { delegate, components, rpcHandler, platform } = createDelegate('light', options);
        const oldComponent = components.get('light:0')!;
        const firstAbility = accessories(delegate).get('light-0')!.abilities[1] as {
            component?: unknown;
            setup(...args: never[]): void;
            onSetHandler(value: boolean): Promise<void>;
        };
        expect(firstAbility.component).toBe(oldComponent);
        setupAbility(firstAbility, platform, delegate);
        components.set('light:0', component('light:0', 0));

        rpcHandler.emit('statusUpdate', {});

        await expect(firstAbility.onSetHandler(true)).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        expect(oldComponent.set).not.toHaveBeenCalled();
        delegate.detach();
    });

    it('removes its profile watcher during delegate teardown', () => {
        vi.useFakeTimers();
        const { delegate, rpcHandler } = createDelegate('rgb');
        const off = vi.spyOn(rpcHandler, 'off');

        delegate.detach();

        expect(off).toHaveBeenCalledWith('statusUpdate', expect.any(Function), delegate);
    });
});
