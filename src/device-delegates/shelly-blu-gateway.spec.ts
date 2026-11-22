import EventEmitter from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import { Categories, LogLevel } from 'homebridge';
import { DynamicComponent, RpcHandler, ShellyBluGatewayGen3, ShellyPlus1Pm } from '@lucavb/shellies-ds9';
import type { Device } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { BTHomeButtonAbility } from '../abilities/bthome-button.ts';
import { BTHomeSensorAbility } from '../abilities/bthome-sensor.ts';
import { ServiceLabelAbility } from '../abilities/service-label.ts';
import { BluTrvAbility } from '../abilities/blu-trv.ts';
import { DeviceDelegate } from './base.ts';
import { BTHomeHostDelegate, ShellyBluGatewayDelegate } from './shelly-blu-gateway.ts';
import { ShellyPlatform } from '../platform.ts';
import type { ShellyPlatform as ShellyPlatformType } from '../platform.ts';
import { bthomeSensorKindDescriptors } from '../utils/bthome.ts';
import type { BTHomeSensorKind } from '../utils/bthome.ts';

const ADDRESS = '3c:2e:f5:71:d5:2a';
const TRV_SUBTYPE = 'blu-trv-3c2ef571d52a';

class MockPlatformAccessory {
    context: Record<string, unknown> = {};
    readonly services: Service[] = [new Service.AccessoryInformation()];

    constructor(
        readonly displayName: string,
        readonly UUID: string,
        readonly category: Categories,
    ) {}

    addService(serviceClass: typeof Service, name?: string, subtype?: string): Service {
        const service = new serviceClass(name, subtype);
        this.services.push(service);
        return service;
    }

    getServiceById(serviceClass: typeof Service, subtype: string): Service | undefined {
        return this.services.find((service) => service.UUID === serviceClass.UUID && service.subtype === subtype);
    }

    getService(serviceClass: typeof Service): Service | undefined {
        return this.services.find((service) => service.UUID === serviceClass.UUID);
    }

    removeService(service: Service) {
        const index = this.services.indexOf(service);
        if (index >= 0) {
            this.services.splice(index, 1);
        }
    }
}

function makeFixture(options?: {
    inventory?: DynamicComponent[];
    knownObjects?: unknown;
    knownObjectsError?: boolean;
    refresh?: () => Promise<void>;
    cachedAccessory?: PlatformAccessory;
    statusResponse?: (id: number) => Promise<unknown>;
    bthomeEnabled?: boolean;
    realGateway?: boolean;
}) {
    const inventory = options?.inventory ?? [];
    let currentInventory = inventory;
    let refreshError = false;
    let refreshComponents = options?.refresh;
    let knownObjects = options?.knownObjects ?? { objects: [] };
    let knownObjectsError = options?.knownObjectsError ?? false;
    const getComponentsResponse = () =>
        Promise.resolve({
            components: currentInventory.map((component) => ({
                key: component.key,
                status: component.status,
                config: component.config,
            })),
            total: currentInventory.length,
            cfg_rev: 1,
        });
    const statusValues = new Map<number, { value: unknown; last_update_ts: unknown }>([
        [201, { value: 22.5, last_update_ts: 1000 }],
    ]);
    const statusResponses = new Map<number, () => Promise<unknown>>();
    const callTrv = vi.fn().mockResolvedValue(undefined);
    if (options?.statusResponse) {
        statusResponses.set(201, () => options.statusResponse!(201));
    }
    const rpcHandler = Object.assign(new EventEmitter(), {
        connected: true,
        request: vi.fn((method: string, params?: Record<string, unknown>) => {
            if (method === 'Shelly.GetComponents') {
                return getComponentsResponse();
            }
            if (method === 'BTHomeDevice.GetKnownObjects') {
                return knownObjectsError
                    ? Promise.reject(new Error('capability request failed'))
                    : Promise.resolve(knownObjects);
            }
            if (method === 'BTHomeSensor.GetStatus') {
                const id = Number(params?.id);
                const response = statusResponses.get(id);
                return response ? response() : Promise.resolve(statusValues.get(id));
            }
            return Promise.reject(new Error(`Unexpected RPC ${method}`));
        }),
    });
    const fakeDevice = Object.assign(new EventEmitter(), {
        id: 'shellyplus1-test',
        modelName: 'Shelly Plus 1',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        firmware: { version: '1.0.0' },
        system: { config: { device: { name: 'Test Host' } } },
        rpcHandler,
        refreshBTHomeComponents: async () => {
            if (refreshComponents) {
                await refreshComponents();
            } else {
                if (refreshError) {
                    throw new Error('inventory request failed');
                }
            }
        },
        callTrv,
        getComponent: (key: string) => currentInventory.find((component) => component.key === key),
        [Symbol.iterator]: function* () {
            for (const component of currentInventory) {
                yield [component.key, component] as [string, DynamicComponent];
            }
        },
        getComponent: (key: string) => currentInventory.find((component) => component.key === key),
    });
    const device = (options?.realGateway
        ? new ShellyBluGatewayGen3(
              { id: 'shellyplus1-test', mac: 'aa:bb:cc:dd:ee:ff', model: 'S3GW-1DBT001', ver: '1.0.0' },
              rpcHandler as never,
          )
        : fakeDevice) as unknown as Device;
    const bindComponents = (components: DynamicComponent[]) => {
        for (const component of components) {
            if (!options?.realGateway) {
                (component as unknown as { device: Device }).device = device;
            }
        }
    };
    bindComponents(currentInventory);

    const registered = new Map<string, PlatformAccessory>();
    const removed: PlatformAccessory[] = [];
    const addAccessory = vi.fn((...accessories: PlatformAccessory[]) => {
        for (const accessory of accessories) {
            registered.set((accessory as unknown as MockPlatformAccessory).UUID, accessory);
        }
    });
    if (options?.cachedAccessory) {
        registered.set((options.cachedAccessory as unknown as MockPlatformAccessory).UUID, options.cachedAccessory);
    }
    // Real platform methods (markBTHomeAccessoriesUnavailable,
    // claimBTHomePeripheral, releaseBTHomePeripheral) are inherited from
    // ShellyPlatform.prototype; only the platform state they read is faked.
    const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
        options: { bthome: { enable: options?.bthomeEnabled ?? true } },
        log: {
            log: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        api: {
            hap: { uuid, Characteristic, Service, HAPStatus, HapStatusError },
            platformAccessory: MockPlatformAccessory,
            user: { persistPath: () => '/tmp' },
        },
        customCharacteristics: {},
        customServices: {},
        getAccessory: (id: string) => registered.get(id),
        addAccessory,
        removeAccessory: (...accessories: PlatformAccessory[]) => {
            for (const accessory of accessories) {
                registered.delete((accessory as unknown as MockPlatformAccessory).UUID);
                removed.push(accessory);
            }
        },
        getBTHomeAccessories: (deviceId: string) =>
            Array.from(registered.values()).filter((accessory) => {
                const owner = accessory.context.device as { id?: unknown } | undefined;
                return (
                    owner?.id === deviceId && typeof (owner as { bthomeAddress?: unknown }).bthomeAddress === 'string'
                );
            }),
        bthomePeripheralOwners: new Map<string, string>(),
    } as unknown as ShellyPlatformType);

    const delegate = new BTHomeHostDelegate(device, { exclude: false, protocol: 'websocket' }, platform);
    const refresh = async () => {
        await (delegate as unknown as { refreshInventory: () => Promise<void> }).refreshInventory();
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
    };
    return {
        delegate,
        device,
        platform,
        registered,
        removed,
        refresh,
        callTrv,
        setInventory(value: DynamicComponent[]) {
            currentInventory = value;
            bindComponents(value);
        },
        setRefreshError(value: boolean) {
            refreshError = value;
        },
        setRefreshComponents(value: () => Promise<void>) {
            refreshComponents = value;
        },
        setKnownObjects(value: unknown) {
            knownObjects = value;
            knownObjectsError = false;
        },
        setKnownObjectsError() {
            knownObjectsError = true;
        },
        setStatus(id: number, value: unknown) {
            statusValues.set(id, { value, last_update_ts: 1000 });
        },
        setStatusAt(id: number, value: unknown, timestamp: unknown) {
            statusValues.set(id, { value, last_update_ts: timestamp });
        },
        setStatusResponse(id: number, response: () => Promise<unknown>) {
            statusResponses.set(id, response);
        },
    };
}

function makeComponent(
    key: string,
    config: Record<string, unknown>,
    status?: Record<string, unknown>,
): DynamicComponent {
    const id = Number(key.split(':')[1]);
    const component = new DynamicComponent({} as never, {
        key,
        rpcName: key.startsWith('bthomedevice:') ? 'BTHomeDevice' : 'BTHomeSensor',
        kind: 'unknown',
        id,
    });
    component.config = config;
    if (status) {
        component.update(status);
    }
    return component;
}

/** Thin RPC handler for real ds9 Device instances used by the companion wiring test. */
class CompanionRpcHandler extends RpcHandler {
    constructor() {
        super('test');
    }

    connected = true;
    request = vi.fn().mockResolvedValue({});
    destroy = vi.fn().mockResolvedValue(undefined);
}

function makeStandaloneDevice(id: string, model: string): Device {
    const rpcHandler = Object.assign(new EventEmitter(), {
        connected: true,
        request: vi.fn(() => Promise.reject(new Error('unexpected RPC'))),
    });
    return Object.assign(new EventEmitter(), {
        id,
        model,
        modelName: `Model ${model}`,
        macAddress: 'aa:bb:cc:dd:ee:ff',
        firmware: { version: '1.0.0' },
        system: { config: { device: { name: 'Test Host' } } },
        rpcHandler,
        refreshBTHomeComponents: vi.fn(async () => undefined),
        getComponent: () => undefined,
        [Symbol.iterator]: function* () {},
    }) as unknown as Device;
}

function makeHandleAddedPlatform(storeDevice = vi.fn()) {
    return Object.assign(Object.create(ShellyPlatform.prototype), {
        shuttingDown: false,
        deviceDelegates: new Map(),
        bthomeDelegates: new Map(),
        deviceCache: { storeDevice },
        options: {
            bthome: { enable: true },
            getDeviceOptions: vi.fn(() => ({})),
        },
        log: {
            log: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        api: {
            hap: { uuid, Characteristic, Service, HAPStatus, HapStatusError },
            platformAccessory: MockPlatformAccessory,
            user: { persistPath: () => '/tmp' },
        },
        getAccessory: vi.fn(() => undefined),
        addAccessory: vi.fn(),
        removeAccessory: vi.fn(),
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatformType);
}

function makeTrvComponent(
    key = 'blutrv:200',
    config: Record<string, unknown> = { addr: ADDRESS },
    status: Record<string, unknown> = {
        current_C: 20,
        target_C: 21,
        pos: 30,
        errors: [],
        paired: true,
        rsv: 1,
        packet_id: 1,
        last_updated_ts: 1000,
    },
): DynamicComponent {
    const id = Number(key.split(':')[1]);
    const component = new DynamicComponent({} as never, {
        key,
        rpcName: 'BluTrv',
        kind: 'unknown',
        id,
    });
    component.config = config;
    component.update(status);
    return component;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('ShellyBluGatewayDelegate', () => {
    it('registers the installed BLU Gateway Gen3 model', () => {
        expect(DeviceDelegate.getDelegate('S3GW-1DBT001')).toBe(ShellyBluGatewayDelegate);
    });

    it('uses the BTHome host lifecycle for gateway inventory', () => {
        expect(ShellyBluGatewayDelegate.prototype).toBeInstanceOf(BTHomeHostDelegate);
    });

    it('exposes a TRV-only inventory as one address-stable thermostat and routes writes to its gateway ID', async () => {
        vi.useFakeTimers();
        const trv = makeTrvComponent();
        const fixture = makeFixture({ inventory: [trv] });

        await fixture.refresh();

        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        expect(accessory).toBeDefined();
        expect(fixture.platform.addAccessory).toHaveBeenCalledTimes(1);
        expect(accessory.platformAccessory?.category).toBe(Categories.THERMOSTAT);
        expect(accessory.abilities).toHaveLength(2);
        const ability = accessory.abilities.find((candidate) => candidate instanceof BluTrvAbility)! as BluTrvAbility;
        expect(ability.component).toBe(trv);
        expect(ability.gatewayTrvId).toBe(200);

        const service = accessory.platformAccessory!.getServiceById(Service.Thermostat, TRV_SUBTYPE)!;
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        trv.update({ last_updated_ts: 1001 });
        await Promise.resolve();
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.HEAT);
        const setTarget = (
            ability as unknown as { targetTemperatureSetHandler(value: number): Promise<void> }
        ).targetTemperatureSetHandler.bind(ability);
        await setTarget(24);
        expect(fixture.callTrv).toHaveBeenCalledWith(200, 'TRV.SetTarget', { id: 0, target_C: 24 });

        fixture.delegate.detach();
    });

    it('reuses a cached thermostat identity but keeps persisted values unavailable until a fresh observation', async () => {
        vi.useFakeTimers();
        const cached = new MockPlatformAccessory(
            'Cached TRV',
            uuid.generate(`${ADDRESS}-bthome-${ADDRESS}`),
            Categories.OTHER,
        );
        cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
        const cachedService = cached.addService(Service.Thermostat, 'BLU TRV', TRV_SUBTYPE);
        const currentState = cachedService.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const currentTemperature = cachedService.getCharacteristic(Characteristic.CurrentTemperature);
        const targetTemperature = cachedService.getCharacteristic(Characteristic.TargetTemperature);
        currentState.updateValue(Characteristic.CurrentHeatingCoolingState.HEAT);
        currentTemperature.updateValue(20);
        targetTemperature.updateValue(22);

        const trv = makeTrvComponent();
        const fixture = makeFixture({ inventory: [trv], cachedAccessory: cached as unknown as PlatformAccessory });
        fixture.platform.markBTHomeAccessoriesUnavailable('shellyplus1-test');
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        await fixture.refresh();

        const managed = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        expect(managed.platformAccessory).toBe(cached);
        expect(cached.services.filter((service) => service.UUID === Service.Thermostat.UUID)).toHaveLength(1);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(targetTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(fixture.platform.addAccessory).toHaveBeenCalledTimes(1);

        fixture.delegate.detach();
    });

    it('preserves the service across gateway ID reassignment and rejects old queued commands', async () => {
        vi.useFakeTimers();
        const trv = makeTrvComponent();
        const fixture = makeFixture({ inventory: [trv] });
        await fixture.refresh();

        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const platformAccessory = accessory.platformAccessory!;
        const service = platformAccessory.getServiceById(Service.Thermostat, TRV_SUBTYPE)!;
        const oldAbility = accessory.abilities.find(
            (candidate) => candidate instanceof BluTrvAbility,
        )! as BluTrvAbility;
        trv.update({ last_updated_ts: 1001 });
        await Promise.resolve();
        await Promise.resolve();

        let finishOldRpc!: () => void;
        fixture.callTrv.mockImplementationOnce(() => new Promise<void>((resolve) => (finishOldRpc = () => resolve())));
        const oldSetter = (
            oldAbility as unknown as { targetTemperatureSetHandler(value: number): Promise<void> }
        ).targetTemperatureSetHandler.bind(oldAbility);
        const pending = oldSetter(22);
        const oldQueued = oldSetter(23);
        await Promise.resolve();
        await Promise.resolve();
        expect(fixture.callTrv).toHaveBeenCalledWith(200, 'TRV.SetTarget', { id: 0, target_C: 22 });

        const replacement = makeTrvComponent('blutrv:201');
        fixture.setInventory([replacement]);
        await fixture.refresh();

        const rebound = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const reboundAbility = rebound.abilities.find(
            (candidate) => candidate instanceof BluTrvAbility,
        )! as BluTrvAbility;
        expect(rebound).toBe(accessory);
        expect(rebound.platformAccessory).toBe(platformAccessory);
        expect(reboundAbility).toBe(oldAbility);
        expect(reboundAbility.component).toBe(replacement);
        expect(reboundAbility.gatewayTrvId).toBe(201);
        expect(platformAccessory.getServiceById(Service.Thermostat, TRV_SUBTYPE)).toBe(service);
        expect(fixture.removed).toHaveLength(0);
        expect(fixture.platform.addAccessory).toHaveBeenCalledTimes(1);

        replacement.update({ last_updated_ts: 1001 });
        await Promise.resolve();
        await Promise.resolve();
        const newSetter = (
            reboundAbility as unknown as { targetTemperatureSetHandler(value: number): Promise<void> }
        ).targetTemperatureSetHandler.bind(reboundAbility);
        const currentWrite = newSetter(24);
        finishOldRpc();
        await expect(pending).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        await expect(oldQueued).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        await expect(currentWrite).resolves.toBeUndefined();

        expect(fixture.callTrv).toHaveBeenCalledTimes(2);
        expect(fixture.callTrv).toHaveBeenNthCalledWith(2, 201, 'TRV.SetTarget', { id: 0, target_C: 24 });
        fixture.delegate.detach();
    });

    it('merges a TRV with BTHome at the same verified address and reconciles replacement and unpair in place', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:202', { addr: ADDRESS });
        const sensor = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 20 });
        const trv = makeTrvComponent();
        const fixture = makeFixture({ inventory: [deviceComponent, sensor, trv] });

        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const platformAccessory = accessory.platformAccessory!;
        expect(platformAccessory.services.filter((service) => service.UUID === Service.Thermostat.UUID)).toHaveLength(
            1,
        );
        expect(platformAccessory.category).toBe(Categories.THERMOSTAT);

        const replacement = makeTrvComponent('blutrv:200', { addr: ADDRESS, name: 'Replaced TRV' });
        fixture.setInventory([deviceComponent, sensor, replacement]);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(accessory.platformAccessory).toBe(platformAccessory);
        expect(platformAccessory.services.filter((service) => service.UUID === Service.Thermostat.UUID)).toHaveLength(
            1,
        );
        expect(
            accessory.abilities.some(
                (candidate) => candidate instanceof BluTrvAbility && candidate.component === replacement,
            ),
        ).toBe(true);
        expect(fixture.platform.addAccessory).toHaveBeenCalledTimes(1);

        const ambiguous = makeTrvComponent('blutrv:202', { addr: ADDRESS });
        fixture.setInventory([deviceComponent, sensor, replacement, ambiguous]);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(fixture.removed).toHaveLength(0);

        const unpaired = makeTrvComponent(
            'blutrv:200',
            { addr: ADDRESS },
            {
                ...replacement.status,
                paired: false,
            },
        );
        fixture.setInventory([deviceComponent, sensor, unpaired]);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(platformAccessory.getServiceById(Service.Thermostat, TRV_SUBTYPE)).toBeUndefined();
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
    });

    it('does not expose a TRV with a missing address or duplicate address identities', async () => {
        vi.useFakeTimers();
        const missing = makeTrvComponent('blutrv:200', {});
        const fixture = makeFixture({ inventory: [missing] });
        await fixture.refresh();
        expect(fixture.delegate['accessories'].size).toBe(0);

        const one = makeTrvComponent('blutrv:200');
        const two = makeTrvComponent('blutrv:201');
        fixture.setInventory([one, two]);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].size).toBe(0);
        expect(fixture.platform.addAccessory).not.toHaveBeenCalled();
        fixture.delegate.detach();
    });

    it('keeps TRV services on incomplete inventory and removes them on authoritative unpair/removal', async () => {
        vi.useFakeTimers();
        const trv = makeTrvComponent();
        const fixture = makeFixture({ inventory: [trv] });
        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const platformAccessory = accessory.platformAccessory!;
        expect(platformAccessory.getServiceById(Service.Thermostat, TRV_SUBTYPE)).toBeDefined();

        fixture.setInventory([makeTrvComponent('blutrv:200', {})]);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(platformAccessory.getServiceById(Service.Thermostat, TRV_SUBTYPE)).toBeDefined();
        expect(fixture.removed).toHaveLength(0);

        fixture.setInventory([makeTrvComponent('blutrv:200', { addr: ADDRESS }, { ...trv.status, paired: false })]);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].has(`bthome-${ADDRESS}`)).toBe(false);
        expect(fixture.removed).toHaveLength(1);
        fixture.delegate.detach();
    });

    it('keeps TRV exposure disabled when the shared BTHome feature is disabled', async () => {
        vi.useFakeTimers();
        const fixture = makeFixture({ inventory: [makeTrvComponent()], bthomeEnabled: false });

        await fixture.refresh();

        expect(fixture.delegate['accessories'].size).toBe(0);
        expect(fixture.platform.addAccessory).not.toHaveBeenCalled();
        fixture.delegate.detach();
    });

    it('invalidates cached sensor readings before an unavailable host can reconnect', () => {
        const cached = new MockPlatformAccessory('Cached', 'cached-bthome', Categories.SENSOR);
        cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
        const service = cached.addService(Service.TemperatureSensor, 'Temperature 1', 'bthome-temperature-2-0');
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        temperature.updateValue(20);
        const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
            accessories: new Map([[cached.UUID, cached]]),
            api: { hap: { Characteristic, HAPStatus, HapStatusError, Service } },
        }) as ShellyPlatform;

        platform.markBTHomeAccessoriesUnavailable();

        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        const deviceContext = cached.context.device as Record<string, unknown>;
        expect((deviceContext.bthomeUnavailableServices as Record<string, unknown>)['bthome-temperature-2-0']).toBe(
            true,
        );
    });

    it('invalidates cached TRV services before host discovery can expose persisted readings', () => {
        const cached = new MockPlatformAccessory('Cached TRV', 'cached-trv', Categories.THERMOSTAT);
        cached.context.device = { id: 'shellyblugatewaygen3-test', bthomeAddress: ADDRESS };
        const service = cached.addService(Service.Thermostat, 'BLU TRV', TRV_SUBTYPE);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const currentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        const targetTemperature = service.getCharacteristic(Characteristic.TargetTemperature);
        currentState.updateValue(Characteristic.CurrentHeatingCoolingState.HEAT);
        currentTemperature.updateValue(21);
        targetTemperature.updateValue(22);
        const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
            accessories: new Map([[cached.UUID, cached]]),
            api: { hap: { Characteristic, HAPStatus, HapStatusError, Service } },
        }) as ShellyPlatform;

        platform.markBTHomeAccessoriesUnavailable();

        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(targetTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
    });

    it('invalidates every BTHome sensor kind recorded in the descriptor table', () => {
        const objectIdByKind = { temperature: 2, humidity: 3, contact: 45, motion: 33, battery: 1 };
        const serviceClassByKind = {
            temperature: Service.TemperatureSensor,
            humidity: Service.HumiditySensor,
            contact: Service.ContactSensor,
            motion: Service.MotionSensor,
            battery: Service.Battery,
        };
        // Tripwire: a kind added to the shared descriptor table must be covered
        // by markBTHomeAccessoriesUnavailable, never silently skipped.
        const kinds = Object.keys(bthomeSensorKindDescriptors) as BTHomeSensorKind[];
        expect(kinds).toHaveLength(Object.keys(objectIdByKind).length);
        for (const kind of kinds) {
            const subtype = `bthome-${kind}-${objectIdByKind[kind]}-0`;
            const cached = new MockPlatformAccessory(`Cached ${kind}`, `cached-${kind}`, Categories.SENSOR);
            cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
            const service = cached.addService(serviceClassByKind[kind], kind, subtype);
            const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
                accessories: new Map([[cached.UUID, cached]]),
                api: { hap: { Characteristic, HAPStatus, HapStatusError, Service } },
            }) as ShellyPlatform;

            platform.markBTHomeAccessoriesUnavailable('shellyplus1-test');

            for (const name of bthomeSensorKindDescriptors[kind].characteristics) {
                expect(service.getCharacteristic(Characteristic[name]).statusCode).toBe(HAPStatus.RESOURCE_BUSY);
            }
            const deviceContext = cached.context.device as Record<string, unknown>;
            expect((deviceContext.bthomeUnavailableServices as Record<string, unknown>)[subtype]).toBe(true);
        }
    });

    it('claims a BTHome peripheral exclusively and releases it only for its owner', () => {
        const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
            bthomePeripheralOwners: new Map<string, string>(),
        }) as ShellyPlatform;

        expect(platform.claimBTHomePeripheral(ADDRESS, 'host-a')).toBe(true);
        expect(platform.claimBTHomePeripheral(ADDRESS, 'host-b')).toBe(false);
        // Re-claiming by the current owner stays idempotent.
        expect(platform.claimBTHomePeripheral(ADDRESS, 'host-a')).toBe(true);

        platform.releaseBTHomePeripheral(ADDRESS, 'host-b');
        expect(platform.bthomePeripheralOwners.get(ADDRESS)).toBe('host-a');

        platform.releaseBTHomePeripheral(ADDRESS, 'host-a');
        expect(platform.bthomePeripheralOwners.has(ADDRESS)).toBe(false);
    });

    it('skips the scheduled inventory refresh while the host is disconnected', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const fixture = makeFixture({ inventory: [deviceComponent] });
        await fixture.refresh();
        const refreshComponents = vi.fn(async () => undefined);
        fixture.setRefreshComponents(refreshComponents);

        fixture.device.rpcHandler.emit('disconnect', 1006, 'offline', null);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(refreshComponents).not.toHaveBeenCalled();

        // Reconnecting refreshes via handleConnect, not via the skipped timer.
        fixture.device.rpcHandler.connected = true;
        fixture.device.rpcHandler.emit('connect');
        await Promise.resolve();
        expect(refreshComponents).toHaveBeenCalledTimes(1);
        fixture.delegate.detach();
    });

    it('re-probes a complete inventory without BTHome components at a slower cadence', async () => {
        vi.useFakeTimers();
        const fixture = makeFixture({ inventory: [] });
        await fixture.refresh();
        const refreshComponents = vi.fn(async () => undefined);
        fixture.setRefreshComponents(refreshComponents);
        await fixture.refresh();
        expect(refreshComponents).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(refreshComponents).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
        expect(refreshComponents).toHaveBeenCalledTimes(2);
        fixture.delegate.detach();
    });

    it('keeps polling a host with BTHome components about every five minutes', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const fixture = makeFixture({ inventory: [deviceComponent] });
        await fixture.refresh();
        const refreshComponents = vi.fn(async () => undefined);
        fixture.setRefreshComponents(refreshComponents);
        await fixture.refresh();
        expect(refreshComponents).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(refreshComponents).toHaveBeenCalledTimes(2);
        fixture.delegate.detach();
    });

    it('invalidates cached BTHome readings before starting device discovery', async () => {
        const calls: string[] = [];
        const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
            shuttingDown: false,
            accessories: new Map(),
            options: { bthome: { enable: true }, mdns: { enable: false } },
            log: { debug: vi.fn() },
            markBTHomeAccessoriesUnavailable: vi.fn(() => calls.push('invalidate')),
            runConfigDeviceDiscoverer: vi.fn(async () => {
                calls.push('config-discovery');
            }),
            deviceCache: { load: vi.fn(async () => undefined) },
            runCacheDeviceDiscoverer: vi.fn(async () => {
                calls.push('cache-discovery');
            }),
        }) as ShellyPlatform;

        await (platform as unknown as { initialize: () => Promise<void> }).initialize();

        expect(calls).toEqual(['invalidate', 'config-discovery', 'cache-discovery']);
    });

    it('reconciles component replacement and button capability changes in place', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({ inventory: [deviceComponent, sensor] });
        await fixture.refresh();
        const original = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const platformAccessory = original.platformAccessory!;
        expect(platformAccessory).toBeDefined();

        const replacement = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 23 });
        fixture.setInventory([deviceComponent, replacement]);
        fixture.setKnownObjects({
            objects: [
                { obj_id: 58, idx: 0 },
                { obj_id: 58, idx: 1 },
            ],
        });
        await fixture.refresh();

        const reconciled = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        expect(reconciled).toBe(original);
        expect(reconciled.platformAccessory).toBe(platformAccessory);
        expect(
            reconciled.abilities.some(
                (ability) => ability instanceof BTHomeSensorAbility && ability.component === replacement,
            ),
        ).toBe(true);
        expect(reconciled.abilities.filter((ability) => ability instanceof BTHomeButtonAbility)).toHaveLength(2);
        expect(fixture.removed).toHaveLength(0);
        expect(fixture.platform.addAccessory).toHaveBeenCalledTimes(1);

        fixture.setKnownObjects({ objects: [] });
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(original);
        expect(original.abilities.filter((ability) => ability instanceof BTHomeButtonAbility)).toHaveLength(0);
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
        expect(fixture.removed).toHaveLength(0);
    });

    it('does not forward inventory status emitted before ds9 updates a reused sensor config', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({ inventory: [deviceComponent, sensor] });
        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const temperature = accessory
            .platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0')!
            .getCharacteristic(Characteristic.CurrentTemperature);
        expect(temperature.value).toBe(22.5);

        const otherAddress = 'aa:bb:cc:dd:ee:ff';
        fixture.setKnownObjectsError();
        fixture.setRefreshComponents(async () => {
            // This is the actual ds9 1.9.0 ordering: retained component,
            // status update/event first, then config assignment.
            sensor.update({ value: 88, last_update_ts: 1001 });
            sensor.config = { addr: otherAddress, obj_id: 2, idx: 0 };
        });
        fixture.device.rpcHandler.emit('connect');
        await fixture.refresh();

        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
    });

    it('does not forward events from a reused BTHome device after its address changes during failed reconciliation', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const fixture = makeFixture({
            inventory: [deviceComponent],
            knownObjects: { objects: [{ obj_id: 58, idx: 0 }] },
        });
        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const button = accessory.abilities.find((ability) => ability instanceof BTHomeButtonAbility)!;
        const eventCharacteristic = button['service'].getCharacteristic(Characteristic.ProgrammableSwitchEvent);
        deviceComponent.emit('event', {
            component: 'bthomedevice:200',
            id: 200,
            event: 'single_push',
            idx: 0,
            ts: 1711200000,
        });
        expect(eventCharacteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        const otherAddress = 'aa:bb:cc:dd:ee:ff';
        fixture.setKnownObjectsError();
        fixture.setRefreshComponents(async () => {
            deviceComponent.emit('event', {
                component: 'bthomedevice:200',
                id: 200,
                event: 'double_push',
                idx: 0,
                ts: 1711200001,
            });
            deviceComponent.config = { addr: otherAddress };
        });
        fixture.device.rpcHandler.emit('connect');
        await fixture.refresh();
        deviceComponent.emit('event', {
            component: 'bthomedevice:200',
            id: 200,
            event: 'double_push',
            idx: 0,
            ts: 1711200002,
        });

        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(eventCharacteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
    });

    it('forwards valid button events during a slow inventory and capability refresh', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const fixture = makeFixture({
            inventory: [deviceComponent],
            knownObjects: { objects: [{ obj_id: 58, idx: 0 }] },
        });
        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const button = accessory.abilities.find((ability) => ability instanceof BTHomeButtonAbility)!;
        const eventCharacteristic = button['service'].getCharacteristic(Characteristic.ProgrammableSwitchEvent);

        let resolveRefresh!: () => void;
        fixture.setRefreshComponents(() => new Promise<void>((resolve) => (resolveRefresh = resolve)));
        fixture.setKnownObjectsError();
        const refresh = fixture.refresh();
        deviceComponent.emit('event', {
            component: 'bthomedevice:200',
            id: 200,
            event: 'double_push',
            idx: 0,
            ts: 1711200001,
        });
        await Promise.resolve();

        expect(eventCharacteristic.value).toBe(Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
        resolveRefresh();
        await refresh;
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        fixture.delegate.detach();
    });

    it('preserves a motion pulse during pending GetKnownObjects discovery', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 33, idx: 0 },
            { value: false, last_update_ts: 1000 },
        );
        const fixture = makeFixture({ inventory: [deviceComponent, sensor] });
        fixture.setStatusAt(201, false, 1000);
        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const motion = accessory
            .platformAccessory!.getServiceById(Service.MotionSensor, 'bthome-motion-33-0')!
            .getCharacteristic(Characteristic.MotionDetected);
        const changes: unknown[] = [];
        motion.on('change', ({ newValue }) => {
            if (typeof newValue === 'boolean') {
                changes.push(newValue);
            }
        });

        let resolveCapabilities!: (value: unknown) => void;
        fixture.setKnownObjects(new Promise((resolve) => (resolveCapabilities = resolve)));
        const pendingRefresh = fixture.refresh();
        for (let i = 0; i < 12; i++) {
            await Promise.resolve();
        }
        expect(fixture.device.rpcHandler.request).toHaveBeenCalledWith('BTHomeDevice.GetKnownObjects', { id: 200 });

        sensor.update({ value: true, last_update_ts: 1001 });
        sensor.update({ value: false, last_update_ts: 1002 });
        await Promise.resolve();
        expect(changes).toEqual([true, false]);

        resolveCapabilities({ objects: [] });
        await pendingRefresh;
        expect(motion.value).toBe(false);
        fixture.delegate.detach();
    });

    it('does not restore a queued pre-disconnect snapshot when inventory discovery completes', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 33, idx: 0 },
            { value: false, last_update_ts: 1000 },
        );
        const fixture = makeFixture({ inventory: [deviceComponent, sensor] });
        fixture.setStatusAt(201, false, 1000);
        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const motion = accessory
            .platformAccessory!.getServiceById(Service.MotionSensor, 'bthome-motion-33-0')!
            .getCharacteristic(Characteristic.MotionDetected);
        const changes: unknown[] = [];
        motion.on('change', ({ newValue }) => {
            if (typeof newValue === 'boolean') {
                changes.push(newValue);
            }
        });

        let resolveCapabilities!: (value: unknown) => void;
        fixture.setKnownObjects(new Promise((resolve) => (resolveCapabilities = resolve)));
        const pendingRefresh = fixture.refresh();
        for (let i = 0; i < 12; i++) {
            await Promise.resolve();
        }
        sensor.update({ value: true, last_update_ts: 1001 });
        fixture.device.rpcHandler.emit('disconnect', 1006, 'offline', null);
        await Promise.resolve();
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        resolveCapabilities({ objects: [] });
        await pendingRefresh;
        expect(motion.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(changes).not.toContain(true);
        fixture.delegate.detach();
    });

    it('validates a reused sensor and button after ds9 config_changed auto-rediscovery', async () => {
        vi.useFakeTimers();
        const deviceSeed = makeComponent('bthomedevice:200', { addr: ADDRESS }, { value: 1 });
        const sensorSeed = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({
            inventory: [deviceSeed, sensorSeed],
            knownObjects: { objects: [{ obj_id: 58, idx: 0 }] },
            realGateway: true,
        });
        await fixture.refresh();

        const gateway = fixture.device as ShellyBluGatewayGen3;
        const deviceComponent = gateway.getComponent('bthomedevice:200') as DynamicComponent;
        const sensor = gateway.getComponent('bthomesensor:201') as DynamicComponent;
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const temperature = accessory
            .platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0')!
            .getCharacteristic(Characteristic.CurrentTemperature);
        const button = accessory.abilities.find((ability) => ability instanceof BTHomeButtonAbility)!;
        const buttonEvent = button['service'].getCharacteristic(Characteristic.ProgrammableSwitchEvent);
        deviceComponent.emit('event', {
            component: 'bthomedevice:200',
            id: 200,
            event: 'single_push',
            idx: 0,
            ts: 1711200000,
        });
        await Promise.resolve();
        expect(buttonEvent.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        const sensorUpdate = vi.spyOn(temperature, 'updateValue');
        const buttonUpdate = vi.spyOn(buttonEvent, 'updateValue');
        const otherAddress = 'aa:bb:cc:dd:ee:ff';
        fixture.setKnownObjectsError();
        fixture.setInventory([
            makeComponent('bthomedevice:200', { addr: otherAddress }, { value: 2 }),
            makeComponent(
                'bthomesensor:201',
                { addr: otherAddress, obj_id: 2, idx: 0 },
                { value: 88, last_update_ts: 1001 },
            ),
        ]);
        deviceComponent.on('change:value', () => {
            deviceComponent.emit('event', {
                component: 'bthomedevice:200',
                id: 200,
                event: 'double_push',
                idx: 0,
                ts: 1711200001,
            });
        });

        fixture.device.rpcHandler.emit('event', { events: [{ event: 'config_changed', ts: 1711200001 }] });
        for (let i = 0; i < 20 && deviceComponent.config?.addr !== otherAddress; i++) {
            await Promise.resolve();
        }
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
        }

        expect(gateway.getComponent('bthomesensor:201')).toBe(sensor);
        expect(deviceComponent.config?.addr).toBe(otherAddress);
        expect(sensor.config?.addr).toBe(otherAddress);
        expect(sensorUpdate).not.toHaveBeenCalledWith(88);
        expect(buttonUpdate).not.toHaveBeenCalledWith(Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(buttonEvent.value).toBe(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

        // A failed capability refresh remains non-authoritative; the old
        // accessory is retained but its mismatched component cannot report.
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(sensorUpdate).not.toHaveBeenCalledWith(88);
        expect(buttonUpdate).not.toHaveBeenCalledWith(Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS);
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
        gateway.rpcHandler.removeAllListeners();
    });

    it('removes adjacent stale cached BTHome services without skipping entries', async () => {
        vi.useFakeTimers();
        const uuidValue = uuid.generate(`${ADDRESS}-bthome-${ADDRESS}`);
        const cached = new MockPlatformAccessory('Cached', uuidValue, Categories.SENSOR);
        cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
        cached.addService(Service.HumiditySensor, 'Old Humidity', 'bthome-humidity-3-0');
        cached.addService(Service.StatelessProgrammableSwitch, 'Old Button', 'bthome-button-0');
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 });
        const fixture = makeFixture({
            inventory: [deviceComponent, sensor],
            cachedAccessory: cached as unknown as PlatformAccessory,
        });

        await fixture.refresh();

        expect(cached.services.some((service) => service.subtype === 'bthome-humidity-3-0')).toBe(false);
        expect(cached.services.some((service) => service.subtype === 'bthome-button-0')).toBe(false);
        expect(cached.services.some((service) => service.subtype === 'bthome-temperature-2-0')).toBe(true);
        fixture.delegate.detach();
    });

    it('keeps cached accessories on malformed metadata or capability queries, then removes an authoritative unpair', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({ inventory: [deviceComponent, sensor] });
        await fixture.refresh();
        const original = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;

        fixture.setKnownObjects({ objects: [{ obj_id: 58 }] });
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(original);
        expect(fixture.removed).toHaveLength(0);

        fixture.setKnownObjectsError();
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(original);

        const malformed = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2 }, { value: 22.5 });
        fixture.setInventory([deviceComponent, malformed]);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(original);

        fixture.setInventory([]);
        fixture.setRefreshError(true);
        await fixture.refresh();
        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(original);
        expect(fixture.removed).toHaveLength(0);

        fixture.setRefreshError(false);
        await fixture.refresh();
        expect(fixture.removed).toHaveLength(1);
        fixture.delegate.detach();
    });

    it('removes cached host-owned peripherals confirmed unpaired before this process started', async () => {
        vi.useFakeTimers();
        const cached = new MockPlatformAccessory('Cached', 'cached-bthome', Categories.SENSOR);
        cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
        const fixture = makeFixture({ inventory: [], cachedAccessory: cached as unknown as PlatformAccessory });
        await fixture.refresh();
        expect(fixture.removed).toContain(cached);
        fixture.delegate.detach();
    });

    it('marks readings unavailable on disconnect and restores only on a fresh status response', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({ inventory: [deviceComponent, sensor] });
        await fixture.refresh();
        const managed = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const ability = managed.abilities.find((entry) => entry instanceof BTHomeSensorAbility) as BTHomeSensorAbility;
        const service = managed.platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0')!;
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);

        fixture.device.rpcHandler.emit('disconnect', 1006, 'offline', null);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        fixture.device.rpcHandler.connected = true;
        fixture.setStatusAt(201, 22.5, 1000);
        fixture.device.rpcHandler.emit('connect');
        await fixture.refresh();
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        fixture.setStatusAt(201, 24, 1001);
        await fixture.refresh();
        expect(temperature.value).toBe(24);
        expect(temperature.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
        fixture.delegate.detach();
    });

    it('normalizes the plural TRV-independent timestamp alias from BTHome GetStatus', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({
            inventory: [deviceComponent, sensor],
            statusResponse: async () => ({ value: 24, last_updated_ts: 1001 }),
        });

        await fixture.refresh();

        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const temperature = accessory
            .platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0')!
            .getCharacteristic(Characteristic.CurrentTemperature);
        expect(temperature.value).toBe(24);
        expect(temperature.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        fixture.delegate.detach();
    });

    it('rejects conflicting BTHome timestamp aliases from GetStatus', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({
            inventory: [deviceComponent, sensor],
            statusResponse: async () => ({ value: 24, last_update_ts: 1001, last_updated_ts: 1002 }),
        });

        await fixture.refresh();

        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const temperature = accessory
            .platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0')!
            .getCharacteristic(Characteristic.CurrentTemperature);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        fixture.delegate.detach();
    });

    it('marks cached host-owned readings unavailable when startup inventory is offline', async () => {
        vi.useFakeTimers();
        const cached = new MockPlatformAccessory('Cached', 'cached-bthome', Categories.SENSOR);
        cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
        const service = cached.addService(Service.TemperatureSensor, 'Temperature 1', 'bthome-temperature-2-0');
        const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        temperature.updateValue(20);
        const fixture = makeFixture({
            inventory: [],
            cachedAccessory: cached as unknown as PlatformAccessory,
            refresh: async () => {
                throw new Error('offline');
            },
        });

        fixture.platform.markBTHomeAccessoriesUnavailable('shellyplus1-test');
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
    });

    it('detaches non-destructively and invalidates a pending refresh', async () => {
        vi.useFakeTimers();
        let resolveRefresh!: () => void;
        const pendingRefresh = new Promise<void>((resolve) => (resolveRefresh = resolve));
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 });
        const fixture = makeFixture({ inventory: [deviceComponent, sensor], refresh: () => pendingRefresh });
        const pending = (fixture.delegate as unknown as { refreshInventory: () => Promise<void> }).refreshInventory();
        fixture.delegate.detach();
        resolveRefresh();
        await pending;
        expect(fixture.platform.addAccessory).not.toHaveBeenCalled();
        expect(fixture.removed).toHaveLength(0);
    });

    it('does not continue inventory work when detached during a capability query', async () => {
        vi.useFakeTimers();
        let resolveCapabilities!: (value: unknown) => void;
        const capabilities = new Promise<unknown>((resolve) => (resolveCapabilities = resolve));
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 });
        const fixture = makeFixture({ inventory: [deviceComponent, sensor], knownObjects: capabilities });
        const pending = (fixture.delegate as unknown as { refreshInventory: () => Promise<void> }).refreshInventory();
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }
        expect(fixture.device.rpcHandler.request).toHaveBeenCalledWith('BTHomeDevice.GetKnownObjects', { id: 200 });

        fixture.delegate.detach();
        resolveCapabilities({ objects: [{ obj_id: 58, idx: 0 }] });
        await pending;
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }
        expect(fixture.device.rpcHandler.request).toHaveBeenCalledTimes(1);
        expect(fixture.platform.addAccessory).not.toHaveBeenCalled();
        expect(fixture.removed).toHaveLength(0);
    });

    it('ignores a late successful status response after authoritative removal', async () => {
        vi.useFakeTimers();
        let resolveStatus!: (value: unknown) => void;
        const staleStatus = new Promise<unknown>((resolve) => (resolveStatus = resolve));
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 });
        const fixture = makeFixture({ inventory: [deviceComponent, sensor], statusResponse: () => staleStatus });
        await fixture.refresh();
        const managed = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const ability = managed.abilities.find((entry) => entry instanceof BTHomeSensorAbility) as BTHomeSensorAbility;
        const observe = vi.spyOn(ability, 'observeStatus');

        fixture.setInventory([]);
        await fixture.refresh();
        resolveStatus({ value: 24, last_update_ts: 1001 });
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }
        expect(observe).not.toHaveBeenCalled();
        expect(fixture.removed).toHaveLength(1);
        fixture.delegate.detach();
    });

    it('ignores a late failed status request after replacing the component binding', async () => {
        vi.useFakeTimers();
        let rejectOldStatus!: (error: Error) => void;
        const staleStatus = new Promise<unknown>((_resolve, reject) => (rejectOldStatus = reject));
        let statusCalls = 0;
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 });
        const fixture = makeFixture({
            inventory: [deviceComponent, sensor],
            statusResponse: () => {
                statusCalls++;
                return statusCalls === 1 ? staleStatus : Promise.resolve({ value: 23, last_update_ts: 1001 });
            },
        });
        await fixture.refresh();
        const managed = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const oldAbility = managed.abilities.find(
            (entry) => entry instanceof BTHomeSensorAbility,
        ) as BTHomeSensorAbility;
        const unavailable = vi.spyOn(oldAbility, 'markUnavailable');

        const replacement = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 23 });
        fixture.setInventory([deviceComponent, replacement]);
        await fixture.refresh();
        rejectOldStatus(new Error('late status failure'));
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }
        expect(unavailable).not.toHaveBeenCalled();
        expect(
            managed.abilities.some((entry) => entry instanceof BTHomeSensorAbility && entry.component === replacement),
        ).toBe(true);
        fixture.delegate.detach();
    });

    it('closes late device connections and does not attach delegates after shutdown begins', async () => {
        const existingDestroy = vi.fn(() => Promise.resolve());
        const lateDestroy = vi.fn(() => Promise.resolve());
        const shellies = Object.assign(new EventEmitter(), {
            unregisterDiscoverer: vi.fn(),
            values: () => [{ rpcHandler: { destroy: existingDestroy } }],
        });
        const discoverer = {} as never;
        const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
            shuttingDown: false,
            discoverers: new Set([discoverer]),
            mdnsDiscoverer: undefined,
            shellies,
            deviceDelegates: new Map(),
            bthomeDelegates: new Map(),
            log: { debug: vi.fn() },
        }) as ShellyPlatform;
        shellies.on(
            'add',
            (platform as unknown as { handleAddedDevice: (device: Device) => void }).handleAddedDevice,
            platform,
        );

        (platform as unknown as { detach: () => void }).detach();
        shellies.emit('add', { rpcHandler: { destroy: lateDestroy } } as unknown as Device);
        await Promise.resolve();

        expect(existingDestroy).toHaveBeenCalledOnce();
        expect(lateDestroy).toHaveBeenCalledOnce();
        expect(shellies.unregisterDiscoverer).toHaveBeenCalledWith(discoverer);
        expect(platform.deviceDelegates.size).toBe(0);
        expect(platform.bthomeDelegates.size).toBe(0);
    });

    it('exposes a ServiceLabel service on hosted button accessories and keeps it across reconcile cycles', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({
            inventory: [deviceComponent, sensor],
            knownObjects: {
                objects: [
                    { obj_id: 58, idx: 0 },
                    { obj_id: 58, idx: 1 },
                ],
            },
        });

        await fixture.refresh();

        // HAP requires a ServiceLabel service whenever ServiceLabelIndex is
        // used, which every BTHomeButtonAbility sets.
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const platformAccessory = accessory.platformAccessory!;
        const serviceLabel = platformAccessory.getService(Service.ServiceLabel);
        expect(serviceLabel).toBeDefined();
        expect(accessory.abilities.some((ability) => ability instanceof ServiceLabelAbility)).toBe(true);
        expect(serviceLabel!.getCharacteristic(Characteristic.ServiceLabelNamespace).value).toBe(
            Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
        );

        // The ability list is rebuilt on every reconcile cycle; the
        // ServiceLabel service must survive it as the SAME instance, and the
        // ability must be the accessory's stable one. reconcileAbilities
        // destroys omitted abilities, so a recreated service each cycle would
        // churn the accessory's HAP configuration on every refresh.
        fixture.setKnownObjects({ objects: [{ obj_id: 58, idx: 2 }] });
        await fixture.refresh();

        const reconciled = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        expect(reconciled).toBe(accessory);
        expect(reconciled.platformAccessory).toBe(platformAccessory);
        expect(platformAccessory.getService(Service.ServiceLabel)).toBe(serviceLabel);
        expect(reconciled.abilities.find((ability) => ability instanceof ServiceLabelAbility)).toBe(
            (accessory as unknown as { serviceLabelAbility: ServiceLabelAbility }).serviceLabelAbility,
        );
        expect(reconciled.abilities.filter((ability) => ability instanceof BTHomeButtonAbility)).toHaveLength(1);
        expect(reconciled.abilities.some((ability) => ability instanceof ServiceLabelAbility)).toBe(true);
        fixture.delegate.detach();
    });

    it('removes cached BTHome accessories at initialize when the BTHome feature is disabled', async () => {
        const cached = new MockPlatformAccessory('Cached BTHome', 'cached-bthome', Categories.SENSOR);
        cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
        const regular = new MockPlatformAccessory('Regular', 'regular-accessory', Categories.SWITCH);
        regular.context.device = { id: 'shellyplus1-test' };
        const accessories = new Map<string, PlatformAccessory>([
            [cached.UUID, cached as unknown as PlatformAccessory],
            [regular.UUID, regular as unknown as PlatformAccessory],
        ]);
        const removed: PlatformAccessory[] = [];
        const platform = Object.assign(Object.create(ShellyPlatform.prototype), {
            shuttingDown: false,
            accessories,
            options: { bthome: { enable: false }, mdns: { enable: false } },
            log: { debug: vi.fn() },
            api: { hap: { Characteristic, HAPStatus, HapStatusError, Service } },
            removeAccessory: (...accessoriesToRemove: PlatformAccessory[]) => {
                for (const accessory of accessoriesToRemove) {
                    accessories.delete(accessory.UUID);
                    removed.push(accessory);
                }
            },
            runConfigDeviceDiscoverer: vi.fn(async () => undefined),
            deviceCache: { load: vi.fn(async () => undefined) },
            runCacheDeviceDiscoverer: vi.fn(async () => undefined),
        }) as ShellyPlatformType;

        await (platform as unknown as { initialize: () => Promise<void> }).initialize();

        expect(removed).toEqual([cached as unknown as PlatformAccessory]);
        expect(accessories.has(regular.UUID)).toBe(true);
    });

    it('attaches a companion BTHome host to supported devices but not to the BLU gateway itself', async () => {
        vi.useFakeTimers();
        const storeDevice = vi.fn();
        const platform = makeHandleAddedPlatform(storeDevice);
        const handleAddedDevice = (
            platform as unknown as { handleAddedDevice: (device: Device) => Promise<void> }
        ).handleAddedDevice.bind(platform);
        const detachAll = () => {
            for (const delegate of [...platform.bthomeDelegates.values(), ...platform.deviceDelegates.values()]) {
                delegate?.detach();
            }
        };

        try {
            // (a) The BLU gateway delegate owns its BTHome accessories itself,
            // so it must not receive a companion host delegate.
            const gatewayDevice = makeStandaloneDevice('shellyblugateway-partner', 'S3GW-1DBT001');
            await handleAddedDevice(gatewayDevice);
            expect(platform.deviceDelegates.has(gatewayDevice.id)).toBe(true);
            expect(platform.bthomeDelegates.has(gatewayDevice.id)).toBe(false);

            // (b) A supported non-gateway device gets exactly one companion.
            const plusDevice = new ShellyPlus1Pm(
                { id: 'shellyplus1pm-partner', mac: 'aa:bb:cc:dd:ee:01', model: ShellyPlus1Pm.model },
                new CompanionRpcHandler(),
            );
            vi.spyOn(plusDevice, 'refreshBTHomeComponents').mockResolvedValue(undefined);
            await handleAddedDevice(plusDevice as unknown as Device);
            expect(platform.deviceDelegates.has(plusDevice.id)).toBe(true);
            expect(platform.bthomeDelegates.get(plusDevice.id)).toBeInstanceOf(BTHomeHostDelegate);
            expect(platform.deviceCache.storeDevice).toHaveBeenCalledWith(plusDevice);
            expect(platform.bthomeDelegates.size).toBe(1);

            // (c) A ds9-known model without a plugin delegate also gets a
            // companion delegate, and is persisted so its cached peripheral
            // accessories can be re-discovered. (The library never emits 'add'
            // for models it does not know, so a ds9-known model with no plugin
            // delegate — Shelly Plus H&T, 'SNSN-0013A' — is the reachable case.)
            expect(DeviceDelegate.getDelegate('SNSN-0013A')).toBeUndefined();
            const undelegatedDevice = makeStandaloneDevice('undelegated-host', 'SNSN-0013A');
            await handleAddedDevice(undelegatedDevice);
            expect(platform.deviceDelegates.has(undelegatedDevice.id)).toBe(false);
            expect(platform.bthomeDelegates.get(undelegatedDevice.id)).toBeInstanceOf(BTHomeHostDelegate);
            expect(platform.deviceCache.storeDevice).toHaveBeenCalledWith(undelegatedDevice);

            await vi.advanceTimersByTimeAsync(0);
        } finally {
            detachAll();
        }
    });

    it('warns only once about consecutive refresh failures until a refresh succeeds again', async () => {
        vi.useFakeTimers();
        const fixture = makeFixture({ inventory: [] });
        await fixture.refresh();
        const warnCalls = vi.mocked(fixture.platform.log.log).mock.calls.filter((call) => call[0] === LogLevel.WARN);
        expect(warnCalls).toHaveLength(0);

        fixture.setRefreshError(true);
        await fixture.refresh();
        expect(vi.mocked(fixture.platform.log.log).mock.calls.filter((call) => call[0] === LogLevel.WARN)).toEqual([
            [LogLevel.WARN, expect.stringContaining('Failed to refresh hosted BTHome components'), expect.anything()],
        ]);

        // A second consecutive failure must not warn again.
        await fixture.refresh();
        expect(vi.mocked(fixture.platform.log.log).mock.calls.filter((call) => call[0] === LogLevel.WARN)).toHaveLength(
            1,
        );

        // A successful refresh resets the warning so the next failure warns.
        fixture.setRefreshError(false);
        await fixture.refresh();
        expect(vi.mocked(fixture.platform.log.log).mock.calls.filter((call) => call[0] === LogLevel.WARN)).toHaveLength(
            1,
        );

        fixture.setRefreshError(true);
        await fixture.refresh();
        expect(vi.mocked(fixture.platform.log.log).mock.calls.filter((call) => call[0] === LogLevel.WARN)).toHaveLength(
            2,
        );
        fixture.delegate.detach();
    });

    it('retains cached button services when the capability query fails and removes them on an authoritative empty query', async () => {
        vi.useFakeTimers();
        const cached = new MockPlatformAccessory(
            'Cached',
            uuid.generate(`${ADDRESS}-bthome-${ADDRESS}`),
            Categories.SENSOR,
        );
        cached.context.device = { id: 'shellyplus1-test', bthomeAddress: ADDRESS };
        cached.addService(Service.TemperatureSensor, 'Old Temperature', 'bthome-temperature-2-0');
        cached.addService(Service.StatelessProgrammableSwitch, 'Old Button', 'bthome-button-0');
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const fixture = makeFixture({
            inventory: [deviceComponent],
            cachedAccessory: cached as unknown as PlatformAccessory,
        });
        fixture.setKnownObjectsError();

        await fixture.refresh();

        // The capability query failed, so the button inventory is unknown and
        // the cached button service must survive the stale-service sweep
        // (retainedButtonSubtypes from getCachedButtonSubtypes). Unrelated
        // stale services are still removed.
        expect(cached.services.some((service) => service.subtype === 'bthome-button-0')).toBe(true);
        expect(cached.services.some((service) => service.subtype === 'bthome-temperature-2-0')).toBe(false);
        expect(fixture.delegate['accessories'].has(`bthome-${ADDRESS}`)).toBe(true);
        expect(fixture.removed).toHaveLength(0);

        // A successful empty capability query makes the absent buttons
        // authoritative, so now the cached button service goes away. This
        // proves the retention above was not vacuous.
        fixture.setKnownObjects({ objects: [] });
        await fixture.refresh();
        expect(cached.services.some((service) => service.subtype === 'bthome-button-0')).toBe(false);
        expect(fixture.delegate['accessories'].has(`bthome-${ADDRESS}`)).toBe(true);
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
    });

    it('installs a fallback refresh timer when the initial inventory refresh fails', async () => {
        vi.useFakeTimers();
        const refresh = vi.fn(async () => {
            throw new Error('initial refresh failed');
        });
        const fixture = makeFixture({ inventory: [], refresh });

        // setup() already attempted one refresh during construction.
        expect(refresh).toHaveBeenCalledTimes(1);

        // The failed initial refresh must install the fallback timer at the
        // normal interval, so a second refresh attempt happens even though the
        // first inventory never succeeded and the host never reconnected.
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
        fixture.delegate.detach();
    });

    it('keeps a contested BTHome peripheral claim exclusive across two hosts', async () => {
        vi.useFakeTimers();
        const fixtureA = makeFixture({
            inventory: [
                makeComponent('bthomedevice:200', { addr: ADDRESS }),
                makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 }),
            ],
        });
        await fixtureA.refresh();
        expect(fixtureA.delegate['accessories'].has(`bthome-${ADDRESS}`)).toBe(true);

        const deviceComponentB = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensorB = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 });
        const fixtureB = makeFixture({ inventory: [deviceComponentB, sensorB] });
        // Host A manages the peripheral first; host B reports the same address
        // from its own inventory. Host B's own delegate is detached because
        // this test drives a second BTHomeHostDelegate on the SAME platform
        // state, so the claim bookkeeping is genuinely contested.
        (fixtureB.device as { id: string }).id = 'host-b';
        fixtureB.delegate.detach();
        const delegateB = new BTHomeHostDelegate(
            fixtureB.device,
            { exclude: false, protocol: 'websocket' },
            fixtureA.platform,
        );
        const refreshB = async () => {
            await (delegateB as unknown as { refreshInventory: () => Promise<void> }).refreshInventory();
            for (let i = 0; i < 8; i++) {
                await Promise.resolve();
            }
            await vi.advanceTimersByTimeAsync(0);
        };
        await refreshB();

        // Host A keeps managing the peripheral; host B's reconcile skipped it
        // because its claim failed, so no peripheral state or accessory exists
        // on host B.
        expect(fixtureA.delegate['accessories'].has(`bthome-${ADDRESS}`)).toBe(true);
        expect(delegateB['accessories'].has(`bthome-${ADDRESS}`)).toBe(false);
        expect(fixtureA.platform.bthomePeripheralOwners.get(ADDRESS)).toBe('shellyplus1-test');
        expect(fixtureA.platform.addAccessory).toHaveBeenCalledTimes(1);
        fixtureA.delegate.detach();
        delegateB.detach();
    });

    it('marks a current sensor binding unavailable when its GetStatus request fails', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({
            inventory: [deviceComponent, sensor],
            statusResponse: () => Promise.reject(new Error('status request failed')),
        });

        await fixture.refresh();

        // The rejected GetStatus belongs to the current binding, so the
        // hydration catch must mark the reading unavailable instead of leaving
        // the seeded component value exposed as live.
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        const temperature = accessory
            .platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0')!
            .getCharacteristic(Characteristic.CurrentTemperature);
        expect(temperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        fixture.delegate.detach();
    });

    it('treats a bthome inventory entry that is not a DynamicComponent as incomplete', async () => {
        vi.useFakeTimers();
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        const sensor = makeComponent(
            'bthomesensor:201',
            { addr: ADDRESS, obj_id: 2, idx: 0 },
            { value: 22.5, last_update_ts: 1000 },
        );
        const fixture = makeFixture({ inventory: [deviceComponent, sensor] });
        await fixture.refresh();
        const accessory = fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)!;
        expect(
            accessory.platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0'),
        ).toBeDefined();

        // A foreign inventory entry with a bthome key but no DynamicComponent
        // wrapper makes the refresh non-authoritative: it is not an unpair
        // proof, so managed peripherals and cached accessories are kept.
        const foreign = { key: 'bthomedevice:200', config: { addr: ADDRESS } };
        fixture.setInventory([foreign as unknown as DynamicComponent]);
        await fixture.refresh();

        expect(fixture.delegate['accessories'].get(`bthome-${ADDRESS}`)).toBe(accessory);
        expect(
            accessory.platformAccessory!.getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0'),
        ).toBeDefined();
        expect(fixture.removed).toHaveLength(0);
        fixture.delegate.detach();
    });

    it('does not adopt a BLU TRV component on a host without callTrv', async () => {
        vi.useFakeTimers();
        const fixture = makeFixture({ inventory: [makeTrvComponent()] });
        // Strip gateway support so the inventory's TRV component cannot be
        // adopted: without callTrv the TRV-bearing inventory stays incomplete.
        delete (fixture.device as { callTrv?: unknown }).callTrv;

        await fixture.refresh();

        expect(fixture.delegate['accessories'].size).toBe(0);
        expect(fixture.platform.addAccessory).not.toHaveBeenCalled();
        fixture.delegate.detach();
    });

    it('recovers a timestampless sensor through GetStatus after a persisted unavailable marker', async () => {
        vi.useFakeTimers();
        const cached = new MockPlatformAccessory(
            'Cached',
            uuid.generate(`${ADDRESS}-bthome-${ADDRESS}`),
            Categories.SENSOR,
        );
        cached.context.device = {
            id: 'shellyplus1-test',
            bthomeAddress: ADDRESS,
            // Persisted unavailable marker without a matching timestamp.
            bthomeUnavailableServices: { 'bthome-temperature-2-0': true },
        };
        const deviceComponent = makeComponent('bthomedevice:200', { addr: ADDRESS });
        // Neither the component status nor the GetStatus response carries a
        // timestamp, so no observation watermark can ever exist for this host
        // and the first live report must be published.
        const sensor = makeComponent('bthomesensor:201', { addr: ADDRESS, obj_id: 2, idx: 0 }, { value: 22.5 });
        const fixture = makeFixture({
            inventory: [deviceComponent, sensor],
            cachedAccessory: cached as unknown as PlatformAccessory,
            statusResponse: async () => ({ value: 24 }),
        });

        await fixture.refresh();

        const temperature = cached
            .getServiceById(Service.TemperatureSensor, 'bthome-temperature-2-0')!
            .getCharacteristic(Characteristic.CurrentTemperature);
        expect(temperature.value).toBe(24);
        expect(temperature.statusCode).not.toBe(HAPStatus.RESOURCE_BUSY);
        fixture.delegate.detach();
    });
});
