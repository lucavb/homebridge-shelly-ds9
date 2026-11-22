import EventEmitter from 'eventemitter3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { DynamicComponent, parseComponentKey, ShellyBluGatewayGen3 } from '@lucavb/shellies-ds9';
import type { Device } from '@lucavb/shellies-ds9';

import { DeviceLogger } from '../utils/device-logger.ts';
import { ShellyPlatform } from '../platform.ts';
import { Accessory } from '../accessory.ts';
import { BluTrvAbility } from './blu-trv.ts';
import { parseBTHomeAddress } from '../utils/bthome.ts';

type TestStatus = Record<string, unknown>;
const TRV_ADDRESS = '3c:2e:f5:71:d5:2a';

function createComponent(
    initialStatus: TestStatus = {
        current_C: 20,
        target_C: 21,
        pos: 0,
        paired: true,
        rsv: 1,
    },
) {
    const rpcEmitter = new EventEmitter();
    const rpcHandler = Object.assign(rpcEmitter, {
        connected: true,
        on: rpcEmitter.on.bind(rpcEmitter),
        off: rpcEmitter.off.bind(rpcEmitter),
        emit: rpcEmitter.emit.bind(rpcEmitter),
    });
    const callTrv = vi.fn().mockResolvedValue(undefined);
    let currentComponent: DynamicComponent | undefined;
    const gateway = {
        rpcHandler,
        callTrv,
        getComponent: (key: string) => (currentComponent?.key === key ? currentComponent : undefined),
    };
    const parsedComponent = parseComponentKey('blutrv:200');
    const component = new DynamicComponent(gateway as unknown as Device, parsedComponent);
    component.config = { addr: TRV_ADDRESS };
    currentComponent = component;
    component.update(initialStatus);

    return {
        component,
        gateway: gateway as unknown as ShellyBluGatewayGen3,
        callTrv,
        rpcHandler,
        setStatus: async (key: string, value: unknown) => {
            component.update({ [key]: value });
            await Promise.resolve();
        },
        setComponent: (value: DynamicComponent) => {
            currentComponent = value;
        },
        setConnected: (value: boolean) => {
            rpcHandler.connected = value;
            rpcEmitter.emit(value ? 'connect' : 'disconnect');
        },
    };
}

function createPlatform(): ShellyPlatform {
    return {
        log: {
            log: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        api: {
            hap: {
                uuid,
                Characteristic,
                Service,
                HAPStatus,
                HapStatusError,
            },
        },
        customCharacteristics: {},
        customServices: {},
    } as unknown as ShellyPlatform;
}

function getGatewayTrvId(component: DynamicComponent): number {
    const parsed = parseComponentKey(component.key);
    if (!('id' in parsed) || typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id) || parsed.id < 0) {
        throw new Error(`Invalid BLU TRV component key: ${component.key}`);
    }
    return parsed.id;
}

function activateAbility(ability: BluTrvAbility) {
    const platform = createPlatform();
    const platformAccessory = {
        addService: (serviceClass: typeof Service, name?: string, subtype?: string) => new serviceClass(name, subtype),
        getService: () => undefined,
        getServiceById: () => undefined,
        removeService: vi.fn(),
    } as unknown as PlatformAccessory;
    const log = new DeviceLogger({ id: 'shellyblugatewaygen3-test' } as never, 'Test BLU TRV', platform.log);

    ability.setup(platformAccessory, platform, log);

    return ability['service'];
}

function setupAbility(component: DynamicComponent, gateway: ShellyBluGatewayGen3) {
    // A real host integration performs this same parse/validation before
    // passing its explicit gateway component ID to the ability.
    const trvId = getGatewayTrvId(component);
    const address = parseBTHomeAddress(component.config?.addr);
    if (!address) {
        throw new Error('Test TRV component requires a verified address');
    }
    const ability = new BluTrvAbility(component, gateway, trvId, address);
    return { ability, service: activateAbility(ability) };
}

function targetSetter(ability: BluTrvAbility) {
    return (
        ability as unknown as { targetTemperatureSetHandler(value: number): Promise<void> }
    ).targetTemperatureSetHandler.bind(ability);
}

/**
 * Builds a gateway whose retained TRV reports the baseline snapshot
 * `{rsv: 1, packet_id: 1, last_updated_ts: 1000}` and returns a `rediscover`
 * helper that replays single-entry GetComponents inventories.
 */
async function setupIdentitySnapshotFixture() {
    const rpcEmitter = new EventEmitter();
    const rpcHandler = Object.assign(rpcEmitter, {
        connected: true,
        request: vi.fn().mockResolvedValue(undefined),
        on: rpcEmitter.on.bind(rpcEmitter),
        off: rpcEmitter.off.bind(rpcEmitter),
    });
    const gateway = new ShellyBluGatewayGen3(
        { id: 'shellyblugatewaygen3-test', mac: '00:00:00:00:00:04' } as never,
        rpcHandler as never,
    );
    const initialInventory = [
        {
            key: 'blutrv:200',
            status: {
                current_C: 20,
                target_C: 21,
                pos: 0,
                paired: true,
                rsv: 1,
                packet_id: 1,
                last_updated_ts: 1000,
                errors: [],
            },
            config: { addr: TRV_ADDRESS },
        },
    ];
    vi.spyOn(gateway.shelly, 'getAllComponents').mockImplementation(async () => initialInventory as never);
    const rediscover = async (entry: Record<string, unknown>) => {
        vi.mocked(gateway.shelly.getAllComponents).mockImplementationOnce(async () => [entry] as never);
        await gateway.rediscoverComponents();
    };

    await gateway.rediscoverComponents();
    const component = gateway.getComponent('blutrv:200') as DynamicComponent;
    const { ability, service } = setupAbility(component, gateway);
    const target = service.getCharacteristic(Characteristic.TargetTemperature);
    return { ability, component, target, rediscover };
}

describe('BluTrvAbility', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('initializes a heat-only thermostat and maps valid valve demand', async () => {
        const { component, gateway, setStatus } = createComponent({
            current_C: 19.5,
            target_C: 22,
            pos: 35,
            paired: true,
            rsv: 4,
        });
        const { ability, service } = setupAbility(component, gateway);

        expect(component).toBeInstanceOf(DynamicComponent);
        expect(component.key).toBe('blutrv:200');
        expect(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).statusCode).toBe(
            HAPStatus.RESOURCE_BUSY,
        );
        await setStatus('packet_id', 1);
        expect(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value).toBe(
            Characteristic.CurrentHeatingCoolingState.HEAT,
        );
        expect(service.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(19.5);
        expect(service.getCharacteristic(Characteristic.TargetTemperature).value).toBe(22);
        expect(service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value).toBe(
            Characteristic.TargetHeatingCoolingState.HEAT,
        );
        expect(service.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.validValues).toEqual([
            Characteristic.TargetHeatingCoolingState.HEAT,
        ]);
        expect(service.getCharacteristic(Characteristic.TargetTemperature).props.minValue).toBe(4);
        expect(service.getCharacteristic(Characteristic.TargetTemperature).props.maxValue).toBe(30);
        expect(service.getCharacteristic(Characteristic.TemperatureDisplayUnits).value).toBe(
            Characteristic.TemperatureDisplayUnits.CELSIUS,
        );
        expect(service.testCharacteristic(Characteristic.HeatingThresholdTemperature)).toBe(false);
        expect(service.testCharacteristic(Characteristic.CoolingThresholdTemperature)).toBe(false);

        ability.detach();
    });

    it('rejects an invalid explicit gateway component ID', () => {
        const { component, gateway } = createComponent();

        expect(() => new BluTrvAbility(component, gateway, Number.NaN, TRV_ADDRESS)).toThrow(RangeError);
        expect(() => new BluTrvAbility(component, gateway, -1, TRV_ADDRESS)).toThrow(RangeError);
    });

    it('updates current state from valve position, treating exactly zero as idle', async () => {
        const { component, gateway, setStatus } = createComponent({
            current_C: 20,
            target_C: 21,
            pos: 45,
            paired: true,
            rsv: 1,
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);

        await setStatus('packet_id', 1);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.HEAT);
        await setStatus('pos', 0);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.OFF);
        await setStatus('pos', 0.01);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.HEAT);

        ability.detach();
    });

    it('marks unavailable fields for missing or invalid status instead of inventing values', async () => {
        const { component, gateway, setStatus } = createComponent({ paired: true, rsv: 1 });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const currentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        const targetTemperature = service.getCharacteristic(Characteristic.TargetTemperature);

        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(targetTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        await setStatus('pos', 101);
        await setStatus('current_C', Number.NaN);
        await setStatus('target_C', 31);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(targetTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        for (const outlier of [-51, 101, 500]) {
            await setStatus('current_C', outlier);
            expect(currentTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        }

        ability.detach();
    });

    it('makes only valve demand unavailable when the gateway reports an unverified fault', async () => {
        const { component, gateway, setStatus } = createComponent({
            current_C: 18.5,
            target_C: 22,
            pos: 40,
            paired: true,
            rsv: 1,
            errors: [],
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const currentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        const targetTemperature = service.getCharacteristic(Characteristic.TargetTemperature);

        await setStatus('packet_id', 1);
        await setStatus('errors', ['not_calibrated']);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.value).toBe(18.5);
        expect(targetTemperature.value).toBe(22);

        await setStatus('errors', []);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.HEAT);

        ability.detach();
    });

    it('replaces DynamicComponent error arrays across direct and retained refreshes', async () => {
        const { component, gateway, callTrv, setStatus } = createComponent({
            current_C: 18.5,
            target_C: 22,
            pos: 40,
            paired: true,
            rsv: 1,
            errors: [],
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const receivedErrors: unknown[] = [];
        component.on('change:errors', (value: unknown) => receivedErrors.push(value));

        await setStatus('packet_id', 1);
        component.update({ errors: ['not_calibrated'] });
        expect(component.status.errors).toEqual(['not_calibrated']);
        expect(receivedErrors.at(-1)).toEqual(['not_calibrated']);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        component.update({ errors: ['not_calibrated', 'second_fault'] });
        expect(component.status.errors).toEqual(['not_calibrated', 'second_fault']);
        expect(receivedErrors.at(-1)).toEqual(['not_calibrated', 'second_fault']);
        component.update({ errors: ['not_calibrated'] });
        expect(component.status.errors).toEqual(['not_calibrated']);
        expect(receivedErrors.at(-1)).toEqual(['not_calibrated']);

        // GetComponents refreshes a retained DynamicComponent through update().
        component.update({ errors: [] });
        await Promise.resolve();
        expect(component.status.errors).toEqual([]);
        expect(receivedErrors.at(-1)).toEqual([]);
        expect(currentState.statusCode).toBe(HAPStatus.SUCCESS);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.HEAT);
        await expect(targetSetter(ability)(23)).resolves.toBeUndefined();
        expect(callTrv).toHaveBeenCalledWith(200, 'TRV.SetTarget', { id: 0, target_C: 23 });

        ability.detach();
        expect(Object.getOwnPropertyDescriptor(component, 'update')).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(component, 'config')).toBeUndefined();
        component.update({ errors: ['after-detach'] });
        // shellies-ds9 1.10 replaces top-level status arrays natively; the
        // plugin relies on that behavior and leaves no own properties behind.
        expect(component.status.errors).toEqual(['after-detach']);
    });

    it('preserves an initial reported fault and clears it only on an explicit empty array', async () => {
        const { component, gateway, callTrv, setStatus } = createComponent({
            current_C: 18.5,
            target_C: 22,
            pos: 40,
            paired: true,
            rsv: 1,
            errors: ['initial_fault'],
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);

        await setStatus('packet_id', 1);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        await expect(targetSetter(ability)(23)).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        expect(callTrv).not.toHaveBeenCalled();

        component.update({ errors: [] });
        await Promise.resolve();
        expect(component.status.errors).toEqual([]);
        expect(currentState.statusCode).toBe(HAPStatus.SUCCESS);
        await expect(targetSetter(ability)(23)).resolves.toBeUndefined();
        ability.detach();
    });

    it('rejects non-heat target modes and non-Celsius display units on real HAP set requests', async () => {
        const { component, gateway, callTrv } = createComponent();
        const { ability, service } = setupAbility(component, gateway);
        const targetMode = service.getCharacteristic(Characteristic.TargetHeatingCoolingState);
        const setTargetMode = (
            targetMode as unknown as {
                handleSetRequest(value: number, connection?: unknown, context?: unknown): Promise<void>;
            }
        ).handleSetRequest.bind(targetMode);
        const displayUnits = service.getCharacteristic(Characteristic.TemperatureDisplayUnits);
        const setDisplayUnits = (
            displayUnits as unknown as {
                handleSetRequest(value: number, connection?: unknown, context?: unknown): Promise<void>;
            }
        ).handleSetRequest.bind(displayUnits);
        const staleWriteChanges: unknown[] = [];
        targetMode.on('change', (change) => {
            if (change.reason === 'write') {
                staleWriteChanges.push(change);
            }
        });

        expect(targetMode.value).toBe(Characteristic.TargetHeatingCoolingState.HEAT);

        await expect(setTargetMode(Characteristic.TargetHeatingCoolingState.COOL)).rejects.toBe(
            HAPStatus.INVALID_VALUE_IN_REQUEST,
        );
        expect(targetMode.value).toBe(Characteristic.TargetHeatingCoolingState.HEAT);
        expect(staleWriteChanges).toHaveLength(0);

        await expect(setTargetMode(Characteristic.TargetHeatingCoolingState.HEAT)).resolves.toBeUndefined();
        expect(callTrv).not.toHaveBeenCalled();
        expect(targetMode.value).toBe(Characteristic.TargetHeatingCoolingState.HEAT);

        await expect(setDisplayUnits(Characteristic.TemperatureDisplayUnits.FAHRENHEIT)).rejects.toBe(
            HAPStatus.INVALID_VALUE_IN_REQUEST,
        );
        expect(displayUnits.value).toBe(Characteristic.TemperatureDisplayUnits.CELSIUS);

        ability.detach();
        await expect(setTargetMode(Characteristic.TargetHeatingCoolingState.HEAT)).rejects.toBe(
            HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
        await expect(setDisplayUnits(Characteristic.TemperatureDisplayUnits.CELSIUS)).rejects.toBe(
            HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
    });

    it('keeps the valve demand unavailable when the gateway reports a non-array errors value', async () => {
        const { component, gateway, callTrv, setStatus } = createComponent({
            current_C: 18.5,
            target_C: 22,
            pos: 40,
            paired: true,
            rsv: 1,
            errors: [],
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const currentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        const targetTemperature = service.getCharacteristic(Characteristic.TargetTemperature);

        const readCurrentState = (
            currentState as unknown as {
                handleGetRequest(connection?: unknown, context?: unknown): Promise<number>;
            }
        ).handleGetRequest.bind(currentState);

        await setStatus('packet_id', 1);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.HEAT);

        await setStatus('errors', 'some_fault');
        expect(component.status.errors).toBe('some_fault');
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        await expect(readCurrentState(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.value).toBe(18.5);
        expect(targetTemperature.value).toBe(22);
        await expect(targetSetter(ability)(23)).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        expect(callTrv).not.toHaveBeenCalled();

        await setStatus('errors', '');
        expect(component.status.errors).toBe('');
        expect(currentState.statusCode).toBe(HAPStatus.SUCCESS);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.HEAT);
        ability.detach();
    });

    it('detaches idempotently through Accessory.reconcileAbilities removal and replacement', async () => {
        class TestPlatformAccessory {
            context: Record<string, unknown> = {};
            readonly services: Service[] = [];

            constructor(
                readonly displayName: string,
                readonly uuidValue: string,
                readonly category: number,
            ) {}

            addService(serviceClass: typeof Service, name?: string, subtype?: string) {
                const service = new serviceClass(name, subtype);
                this.services.push(service);
                return service;
            }

            getService(serviceClass: typeof Service) {
                return this.services.find((service) => service.UUID === serviceClass.UUID);
            }

            getServiceById(serviceClass: typeof Service, subtype: string) {
                return this.services.find(
                    (service) => service.UUID === serviceClass.UUID && service.subtype === subtype,
                );
            }

            removeService(service: Service) {
                const index = this.services.indexOf(service);
                if (index >= 0) {
                    this.services.splice(index, 1);
                }
            }
        }

        const platform = {
            ...createPlatform(),
            api: { ...createPlatform().api, platformAccessory: TestPlatformAccessory },
            getAccessory: vi.fn(() => undefined),
            addAccessory: vi.fn(),
            removeAccessory: vi.fn(),
        } as unknown as ShellyPlatform;
        const { component, gateway, setComponent } = createComponent();
        const originalAbility = new BluTrvAbility(component, gateway, 200, TRV_ADDRESS);
        const detachSpy = vi.spyOn(originalAbility, 'detach');
        const logger = new DeviceLogger({ id: 'shellyblugatewaygen3-test' } as never, 'Test BLU TRV', platform.log);
        const accessory = new Accessory(
            'blu-trv-test',
            'shellyblugatewaygen3-test',
            'BLU TRV',
            platform,
            logger,
            originalAbility,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        // The ability attaches through plain listeners; no own component
        // properties are installed in any lifecycle state.
        expect(component.listenerCount('change:config')).toBeGreaterThan(0);
        expect(component.listenerCount('change:pos')).toBeGreaterThan(0);
        const replacement = new DynamicComponent(gateway as unknown as Device, parseComponentKey('blutrv:200'));
        replacement.config = { addr: TRV_ADDRESS };
        replacement.update({ current_C: 20, target_C: 21, pos: 0, paired: true, rsv: 1, packet_id: 2 });
        setComponent(replacement);
        const replacementAbility = new BluTrvAbility(replacement, gateway, 200, TRV_ADDRESS);
        vi.mocked(platform.log.log).mockClear();

        accessory.reconcileAbilities(replacementAbility);

        expect(originalAbility.active).toBe(false);
        expect(detachSpy).toHaveBeenCalledTimes(2);
        expect(
            platform.log.log.mock.calls.some(([, message]) => String(message).includes('Failed to reconcile ability:')),
        ).toBe(false);
        expect(component.listenerCount('change:config')).toBe(0);
        expect(component.listenerCount('change:pos')).toBe(0);
        expect(replacement.listenerCount('change:config')).toBeGreaterThan(0);
        expect(replacement.listenerCount('change:pos')).toBeGreaterThan(0);
        accessory.detach();
        expect(replacement.listenerCount('change:config')).toBe(0);
        expect(replacement.listenerCount('change:pos')).toBe(0);
    });

    it('rejects an ID-reused component before reconciliation and invalidates its previous readings', async () => {
        const { component, gateway, callTrv, setStatus, setComponent } = createComponent();
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const setTarget = targetSetter(ability);

        await setStatus('packet_id', 1);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.OFF);

        const replacement = new DynamicComponent(gateway as unknown as Device, parseComponentKey('blutrv:200'));
        replacement.config = { addr: 'aa:bb:cc:dd:ee:ff' };
        replacement.update({ current_C: 20, target_C: 21, pos: 100, paired: true, rsv: 1 });
        setComponent(replacement);

        await expect(setTarget(22)).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        expect(callTrv).not.toHaveBeenCalled();
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('rechecks a mutated address before a queued write and invalidates stale readings', async () => {
        const { component, gateway, callTrv, setStatus } = createComponent();
        let finishFirst!: () => void;
        callTrv.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = () => resolve())));
        const { ability, service } = setupAbility(component, gateway);
        const setTarget = targetSetter(ability);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);

        await setStatus('packet_id', 1);
        const pending = setTarget(20);
        const queued = setTarget(21);
        await Promise.resolve();
        await Promise.resolve();
        expect(callTrv).toHaveBeenCalledTimes(1);

        component.config = { addr: 'aa:bb:cc:dd:ee:ff' };
        finishFirst();
        await expect(pending).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        await expect(queued).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        expect(callTrv).toHaveBeenCalledTimes(1);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('keeps target writes within the documented 4–30°C range and sends the exact RPC', async () => {
        const { component, gateway, callTrv, setStatus } = createComponent();
        const { ability } = setupAbility(component, gateway);
        const setTarget = targetSetter(ability);

        await setStatus('packet_id', 1);

        await expect(setTarget(3.9)).rejects.toMatchObject({ hapStatus: HAPStatus.INVALID_VALUE_IN_REQUEST });
        await expect(setTarget(30.1)).rejects.toMatchObject({ hapStatus: HAPStatus.INVALID_VALUE_IN_REQUEST });
        expect(callTrv).not.toHaveBeenCalled();

        await setTarget(4);
        await setTarget(30);
        expect(callTrv).toHaveBeenNthCalledWith(1, 200, 'TRV.SetTarget', { id: 0, target_C: 4 });
        expect(callTrv).toHaveBeenNthCalledWith(2, 200, 'TRV.SetTarget', { id: 0, target_C: 30 });

        ability.detach();
    });

    it('serializes writes, surfaces RPC failures, and continues with the next queued write', async () => {
        const { component, gateway, callTrv, setStatus } = createComponent();
        let failFirst!: (error: Error) => void;
        callTrv.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (failFirst = reject)));
        callTrv.mockResolvedValueOnce(undefined);
        const { ability } = setupAbility(component, gateway);
        const setTarget = targetSetter(ability);

        await setStatus('packet_id', 1);

        const first = setTarget(20);
        const second = setTarget(21);
        await Promise.resolve();
        await Promise.resolve();
        expect(callTrv).toHaveBeenCalledTimes(1);
        failFirst(new Error('RPC failed'));
        await expect(first).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        await second;

        expect(callTrv).toHaveBeenCalledTimes(2);
        expect(callTrv).toHaveBeenNthCalledWith(2, 200, 'TRV.SetTarget', { id: 0, target_C: 21 });
        ability.detach();
    });

    it('rejects commands unless online, paired, and supplied with valid valve state', async () => {
        const { component, gateway, callTrv, setStatus, setConnected } = createComponent();
        const { ability } = setupAbility(component, gateway);
        const setTarget = targetSetter(ability);

        setConnected(false);
        await expect(setTarget(21)).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        setConnected(true);
        await setStatus('paired', false);
        await expect(setTarget(21)).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        await setStatus('paired', true);
        await setStatus('pos', undefined);
        await expect(setTarget(21)).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        await setStatus('pos', 0);
        await setStatus('rsv', -1);
        await expect(setTarget(21)).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });

        expect(callTrv).not.toHaveBeenCalled();
        ability.detach();
    });

    it('rechecks connectivity before sending a queued command', async () => {
        const { component, gateway, callTrv, setConnected, setStatus } = createComponent();
        let finishFirst!: () => void;
        callTrv.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = () => resolve())));
        const { ability } = setupAbility(component, gateway);
        const setTarget = targetSetter(ability);

        await setStatus('packet_id', 1);

        const first = setTarget(20);
        const queued = setTarget(22);
        await Promise.resolve();
        await Promise.resolve();
        expect(callTrv).toHaveBeenCalledTimes(1);

        setConnected(false);
        finishFirst();
        await expect(first).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        await expect(queued).rejects.toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
        expect(callTrv).toHaveBeenCalledTimes(1);

        ability.detach();
    });

    it('does not let a pending HAP target write restore stale state after disconnect', async () => {
        const { component, gateway, callTrv, setStatus, setConnected } = createComponent();
        let finishRpc!: () => void;
        callTrv.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRpc = resolve)));
        const { ability, service } = setupAbility(component, gateway);
        const target = service.getCharacteristic(Characteristic.TargetTemperature);
        const handleSetRequest = (
            target as unknown as {
                handleSetRequest(value: number, connection?: unknown, context?: unknown): Promise<void>;
            }
        ).handleSetRequest.bind(target);
        const staleWriteChanges: unknown[] = [];
        target.on('change', (change) => {
            if (change.reason === 'write') {
                staleWriteChanges.push(change);
            }
        });

        await setStatus('packet_id', 1);
        const pending = handleSetRequest(24, undefined, undefined);
        await Promise.resolve();
        await Promise.resolve();
        expect(callTrv).toHaveBeenCalledTimes(1);

        setConnected(false);
        finishRpc();
        await expect(pending).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(target.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(target.value).not.toBe(24);
        expect(staleWriteChanges).toHaveLength(0);
        ability.detach();
    });

    it('revalidates at the synchronous HAP set callback after a queued disconnect', async () => {
        const { component, gateway, callTrv, setStatus, setConnected } = createComponent();
        let finishRpc!: () => void;
        callTrv.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRpc = resolve)));
        const { ability, service } = setupAbility(component, gateway);
        const target = service.getCharacteristic(Characteristic.TargetTemperature);
        const handleSetRequest = (
            target as unknown as {
                handleSetRequest(value: number, connection?: unknown, context?: unknown): Promise<void>;
            }
        ).handleSetRequest.bind(target);
        const staleWriteChanges: unknown[] = [];
        target.on('change', (change) => {
            if (change.reason === 'write') {
                staleWriteChanges.push(change);
            }
        });

        await setStatus('packet_id', 1);
        const pending = handleSetRequest(24, undefined, undefined);
        await Promise.resolve();
        await Promise.resolve();
        expect(callTrv).toHaveBeenCalledTimes(1);

        finishRpc();
        queueMicrotask(() => setConnected(false));
        await expect(pending).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(target.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(target.value).not.toBe(24);
        expect(staleWriteChanges).toHaveLength(0);
        ability.detach();
    });

    it('does not let a pending HAP target write restore stale state after rebind', async () => {
        const { component, gateway, callTrv, setStatus, setComponent } = createComponent();
        let finishRpc!: () => void;
        callTrv.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRpc = resolve)));
        const { ability, service } = setupAbility(component, gateway);
        const target = service.getCharacteristic(Characteristic.TargetTemperature);
        const handleSetRequest = (
            target as unknown as {
                handleSetRequest(value: number, connection?: unknown, context?: unknown): Promise<void>;
            }
        ).handleSetRequest.bind(target);

        await setStatus('packet_id', 1);
        const pending = handleSetRequest(24, undefined, undefined);
        await Promise.resolve();
        await Promise.resolve();
        expect(callTrv).toHaveBeenCalledTimes(1);

        const replacement = new DynamicComponent(gateway as unknown as Device, parseComponentKey('blutrv:200'));
        replacement.config = { addr: TRV_ADDRESS };
        replacement.update({ current_C: 20, target_C: 25, pos: 0, paired: true, rsv: 1, packet_id: 2 });
        setComponent(replacement);
        component.update({ errors: [] });
        ability.rebind(replacement, gateway, 200);
        expect(component.listenerCount('change:config')).toBe(0);
        expect(component.listenerCount('change:pos')).toBe(0);
        expect(replacement.listenerCount('change:config')).toBeGreaterThan(0);
        expect(replacement.listenerCount('change:pos')).toBeGreaterThan(0);
        // shellies-ds9 1.10 replaces top-level status arrays natively.
        component.update({ errors: ['old-instance'] });
        expect(component.status.errors).toEqual(['old-instance']);
        replacement.update({ errors: ['new-instance'] });
        expect(replacement.status.errors).toEqual(['new-instance']);
        finishRpc();

        await expect(pending).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(target.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(target.value).not.toBe(24);
        ability.detach();
        expect(replacement.listenerCount('change:config')).toBe(0);
        expect(replacement.listenerCount('change:pos')).toBe(0);
        replacement.update({ errors: ['after-detach'] });
        expect(replacement.status.errors).toEqual(['after-detach']);
    });

    it('keeps the HAP read state unavailable when a read overlaps disconnect or rebind', async () => {
        const { component, gateway, setStatus, setConnected } = createComponent();
        const { ability, service } = setupAbility(component, gateway);
        const target = service.getCharacteristic(Characteristic.TargetTemperature);
        const handleGetRequest = (
            target as unknown as {
                handleGetRequest(connection?: unknown, context?: unknown): Promise<number>;
            }
        ).handleGetRequest.bind(target);

        await setStatus('packet_id', 1);
        const beforeDisconnect = target.value;
        const disconnectRead = handleGetRequest(undefined, undefined);
        setConnected(false);
        await expect(disconnectRead).resolves.toBe(beforeDisconnect);
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(target.value).toBe(beforeDisconnect);
        await expect(handleGetRequest(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);

        setConnected(true);
        await setStatus('packet_id', 2);
        const beforeRebind = target.value;
        const rebindRead = handleGetRequest(undefined, undefined);
        const replacement = new DynamicComponent(gateway as unknown as Device, parseComponentKey('blutrv:200'));
        replacement.config = { addr: TRV_ADDRESS };
        replacement.update({ current_C: 20, target_C: 25, pos: 0, paired: true, rsv: 1, packet_id: 3 });
        ability.rebind(replacement, gateway, 200);
        await expect(rebindRead).resolves.toBe(beforeRebind);
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(target.value).toBe(beforeRebind);
        await expect(handleGetRequest(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('rejects reads after config-only retained rediscovery changes component identity', async () => {
        const rpcEmitter = new EventEmitter();
        const rpcHandler = Object.assign(rpcEmitter, {
            connected: true,
            request: vi.fn().mockResolvedValue(undefined),
            on: rpcEmitter.on.bind(rpcEmitter),
            off: rpcEmitter.off.bind(rpcEmitter),
        });
        const gateway = new ShellyBluGatewayGen3(
            { id: 'shellyblugatewaygen3-test', mac: '00:00:00:00:00:02' } as never,
            rpcHandler as never,
        );
        const initialInventory = [
            {
                key: 'blutrv:200',
                status: { current_C: 20, target_C: 21, pos: 0, paired: true, rsv: 1, packet_id: 1 },
                config: { addr: TRV_ADDRESS },
            },
        ];
        vi.spyOn(gateway.shelly, 'getAllComponents').mockImplementation(async () => initialInventory as never);
        await gateway.rediscoverComponents();
        const component = gateway.getComponent('blutrv:200') as DynamicComponent;
        const { ability, service } = setupAbility(component, gateway);
        const target = service.getCharacteristic(Characteristic.TargetTemperature);
        const handleGetRequest = (
            target as unknown as {
                handleGetRequest(connection?: unknown, context?: unknown): Promise<number>;
            }
        ).handleGetRequest.bind(target);

        await Promise.resolve();
        component.update({ packet_id: 2 });
        await Promise.resolve();
        expect(target.statusCode).toBe(HAPStatus.SUCCESS);
        expect(target.value).toBe(21);

        const emptyStatusInventory = [
            {
                key: 'blutrv:200',
                status: {},
                config: { addr: 'aa:bb:cc:dd:ee:ff' },
            },
        ];
        vi.mocked(gateway.shelly.getAllComponents).mockImplementationOnce(async () => emptyStatusInventory as never);
        await gateway.rediscoverComponents();

        expect(gateway.getComponent('blutrv:200')).toBe(component);
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(target.value).toBe(21);
        await expect(handleGetRequest(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);

        component.config = { addr: TRV_ADDRESS };
        component.update({ current_C: 20, target_C: 21, pos: 0, paired: true, rsv: 2, packet_id: 3 });
        await Promise.resolve();
        expect(target.statusCode).toBe(HAPStatus.SUCCESS);

        const omittedStatusInventory = [
            {
                key: 'blutrv:200',
                config: { addr: 'aa:bb:cc:dd:ee:11' },
            },
        ];
        vi.mocked(gateway.shelly.getAllComponents).mockImplementationOnce(async () => omittedStatusInventory as never);
        await gateway.rediscoverComponents();
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        await expect(handleGetRequest(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('requires a complete fresh A snapshot after retained identity changes A to B and back', async () => {
        const rpcEmitter = new EventEmitter();
        const rpcHandler = Object.assign(rpcEmitter, {
            connected: true,
            request: vi.fn().mockResolvedValue(undefined),
            on: rpcEmitter.on.bind(rpcEmitter),
            off: rpcEmitter.off.bind(rpcEmitter),
        });
        const gateway = new ShellyBluGatewayGen3(
            { id: 'shellyblugatewaygen3-test', mac: '00:00:00:00:00:03' } as never,
            rpcHandler as never,
        );
        const initialInventory = [
            {
                key: 'blutrv:200',
                status: { current_C: 20, target_C: 21, pos: 0, paired: true, rsv: 1, packet_id: 1, errors: [] },
                config: { addr: TRV_ADDRESS },
            },
        ];
        vi.spyOn(gateway.shelly, 'getAllComponents').mockImplementation(async () => initialInventory as never);
        const rediscover = async (entry: Record<string, unknown>) => {
            vi.mocked(gateway.shelly.getAllComponents).mockImplementationOnce(async () => [entry] as never);
            await gateway.rediscoverComponents();
        };

        await gateway.rediscoverComponents();
        const component = gateway.getComponent('blutrv:200') as DynamicComponent;
        const { ability, service } = setupAbility(component, gateway);
        const target = service.getCharacteristic(Characteristic.TargetTemperature);
        const handleGetRequest = (
            target as unknown as {
                handleGetRequest(connection?: unknown, context?: unknown): Promise<number>;
            }
        ).handleGetRequest.bind(target);
        const handleSetRequest = (
            target as unknown as {
                handleSetRequest(value: number, connection?: unknown, context?: unknown): Promise<void>;
            }
        ).handleSetRequest.bind(target);

        component.update({ packet_id: 2 });
        await Promise.resolve();
        expect(target.statusCode).toBe(HAPStatus.SUCCESS);

        await rediscover({
            key: 'blutrv:200',
            status: { current_C: 29, target_C: 29, pos: 100, paired: true, rsv: 77, packet_id: 77, errors: [] },
            config: { addr: 'aa:bb:cc:dd:ee:ff' },
        });
        await rediscover({ key: 'blutrv:200', status: {}, config: { addr: TRV_ADDRESS } });

        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(target.value).not.toBe(29);
        await expect(handleGetRequest(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        await expect(handleSetRequest(23, undefined, undefined)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(rpcHandler.request).not.toHaveBeenCalled();

        // An omitted status and irrelevant error-only update cannot establish
        // identity either. Nor can a full-looking payload whose state markers
        // are unchanged from the last verified B snapshot.
        await rediscover({ key: 'blutrv:200', config: { addr: 'aa:bb:cc:dd:ee:ff' } });
        await rediscover({ key: 'blutrv:200', config: { addr: TRV_ADDRESS } });
        await rediscover({ key: 'blutrv:200', status: { errors: [] }, config: { addr: TRV_ADDRESS } });
        await rediscover({
            key: 'blutrv:200',
            status: { current_C: 20, target_C: 21, pos: 0, paired: true, rsv: 77, packet_id: 77, errors: [] },
            config: { addr: TRV_ADDRESS },
        });
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(target.value).not.toBe(29);
        await expect(handleGetRequest(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        await expect(handleSetRequest(23, undefined, undefined)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        expect(rpcHandler.request).not.toHaveBeenCalled();

        await rediscover({
            key: 'blutrv:200',
            status: { current_C: 20, target_C: 21, pos: 0, paired: true, rsv: 78, packet_id: 78, errors: [] },
            config: { addr: TRV_ADDRESS },
        });
        expect(target.statusCode).toBe(HAPStatus.SUCCESS);
        expect(target.value).toBe(21);
        await expect(handleGetRequest(undefined, undefined)).resolves.toBe(21);
        await expect(handleSetRequest(23, undefined, undefined)).resolves.toBeUndefined();
        expect(rpcHandler.request).toHaveBeenCalledTimes(1);
        ability.detach();
    });

    it('does not let an old queued status refresh publish into a rebound lifecycle', async () => {
        const { component, gateway, setStatus, setComponent } = createComponent();
        const { ability, service } = setupAbility(component, gateway);
        const currentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        await setStatus('packet_id', 1);

        component.update({ current_C: 29 });
        const replacement = new DynamicComponent(gateway as unknown as Device, parseComponentKey('blutrv:200'));
        replacement.config = { addr: TRV_ADDRESS };
        replacement.update({ current_C: 22, target_C: 24, pos: 0, paired: true, rsv: 1, packet_id: 2 });
        setComponent(replacement);
        ability.rebind(replacement, gateway, 200);

        // This new-lifecycle observation queues its own refresh after the old
        // component's already-queued callback; the stale callback is a no-op.
        replacement.update({ packet_id: 3 });
        const updateValue = vi.spyOn(currentTemperature, 'updateValue');
        await Promise.resolve();
        expect(currentTemperature.value).toBe(22);
        expect(updateValue).toHaveBeenCalledTimes(1);
        ability.detach();
    });

    it('does not publish status before retained-component identity config settles', async () => {
        const rpcEmitter = new EventEmitter();
        const rpcHandler = Object.assign(rpcEmitter, {
            connected: true,
            request: vi.fn().mockResolvedValue(undefined),
            on: rpcEmitter.on.bind(rpcEmitter),
            off: rpcEmitter.off.bind(rpcEmitter),
        });
        const gateway = new ShellyBluGatewayGen3(
            { id: 'shellyblugatewaygen3-test', mac: '00:00:00:00:00:01' } as never,
            rpcHandler as never,
        );
        const initialInventory = [
            {
                key: 'blutrv:200',
                status: { current_C: 20, target_C: 21, pos: 0, paired: true, rsv: 1, packet_id: 1, errors: [] },
                config: { addr: TRV_ADDRESS },
            },
        ];
        vi.spyOn(gateway.shelly, 'getAllComponents').mockImplementation(async () => initialInventory as never);
        await gateway.rediscoverComponents();
        const component = gateway.getComponent('blutrv:200') as DynamicComponent;
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const currentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature);
        const target = service.getCharacteristic(Characteristic.TargetTemperature);
        const handleGetRequest = (
            target as unknown as {
                handleGetRequest(connection?: unknown, context?: unknown): Promise<number>;
            }
        ).handleGetRequest.bind(target);

        component.update({ packet_id: 2 });
        await Promise.resolve();
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.OFF);
        expect(currentState.statusCode).toBe(HAPStatus.SUCCESS);

        // Exercise the actual GetComponents retained-instance update path for
        // both error-array replacement and its explicit no-fault clear.
        const faultInventory = [
            {
                key: 'blutrv:200',
                status: {
                    current_C: 29,
                    target_C: 29,
                    pos: 100,
                    paired: true,
                    rsv: 2,
                    packet_id: 3,
                    errors: ['fault'],
                },
                config: { addr: TRV_ADDRESS },
            },
        ];
        vi.mocked(gateway.shelly.getAllComponents).mockImplementationOnce(async () => faultInventory as never);
        await gateway.rediscoverComponents();
        expect(gateway.getComponent('blutrv:200')).toBe(component);
        expect(component.status.errors).toEqual(['fault']);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        const clearInventory = [
            {
                key: 'blutrv:200',
                status: { current_C: 21, target_C: 22, pos: 0, paired: true, rsv: 3, packet_id: 4, errors: [] },
                config: { addr: TRV_ADDRESS },
            },
        ];
        vi.mocked(gateway.shelly.getAllComponents).mockImplementationOnce(async () => clearInventory as never);
        await gateway.rediscoverComponents();
        expect(component.status.errors).toEqual([]);
        expect(currentState.statusCode).toBe(HAPStatus.SUCCESS);
        await expect(targetSetter(ability)(23)).resolves.toBeUndefined();

        // On a later rediscovery GenericDevice still updates status first,
        // then assigns config. The same retained component must not publish
        // another valve's status under this accessory.
        const rediscoveryInventory = [
            {
                key: 'blutrv:200',
                // A retained GetComponents refresh may contain only one changed
                // status field before assigning its replacement config.
                status: { current_C: 29 },
                config: { addr: 'aa:bb:cc:dd:ee:ff' },
            },
        ];
        vi.mocked(gateway.shelly.getAllComponents).mockImplementationOnce(async () => rediscoveryInventory as never);
        let readDuringStatusUpdate: Promise<number> | undefined;
        let didReenter = false;
        const readProbe = () => {
            readDuringStatusUpdate = handleGetRequest(undefined, undefined);
            if (!didReenter) {
                didReenter = true;
                component.update({ target_C: 29 });
            }
        };
        component.on('change:current_C', readProbe);
        await gateway.rediscoverComponents();
        component.off('change:current_C', readProbe);
        expect(gateway.getComponent('blutrv:200')).toBe(component);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(currentTemperature.value).not.toBe(29);
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(target.value).not.toBe(29);
        expect(readDuringStatusUpdate).toBeDefined();
        await expect(readDuringStatusUpdate).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        await expect(handleGetRequest(undefined, undefined)).rejects.toBe(HAPStatus.RESOURCE_BUSY);
        ability.detach();
    });

    it('requires newer TRV evidence after reconnect before restoring status or allowing writes', async () => {
        const { component, gateway, callTrv, setConnected, setStatus } = createComponent({
            current_C: 20,
            target_C: 21,
            pos: 0,
            paired: true,
            rsv: 8,
            packet_id: 25,
            last_updated_ts: 1000,
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const setTarget = targetSetter(ability);

        setConnected(false);
        setConnected(true);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        await expect(setTarget(22)).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        expect(callTrv).not.toHaveBeenCalled();

        await setStatus('last_updated_ts', 1001);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.OFF);
        await setTarget(22);
        expect(callTrv).toHaveBeenCalledWith(200, 'TRV.SetTarget', { id: 0, target_C: 22 });

        ability.detach();
    });

    it('prevents old pending and queued writes from sending after destroy and reactivation', async () => {
        const { component, gateway, callTrv, setStatus } = createComponent();
        let failPendingRpc!: (error: Error) => void;
        callTrv.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (failPendingRpc = reject)));
        callTrv.mockResolvedValueOnce(undefined);
        const { ability } = setupAbility(component, gateway);
        const setTarget = targetSetter(ability);

        await setStatus('packet_id', 1);
        const pending = setTarget(20);
        const oldQueued = setTarget(21);
        await Promise.resolve();
        await Promise.resolve();
        expect(callTrv).toHaveBeenCalledTimes(1);

        ability.destroy();
        const reactivatedService = activateAbility(ability);
        await setStatus('packet_id', 2);
        const target = reactivatedService.getCharacteristic(Characteristic.TargetTemperature);
        const handleSetRequest = (
            target as unknown as {
                handleSetRequest(value: number, connection?: unknown, context?: unknown): Promise<void>;
            }
        ).handleSetRequest.bind(target);
        const newLifecycleWrite = handleSetRequest(22, undefined, undefined);
        failPendingRpc(new Error('RPC failed after destruction'));

        await expect(pending).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        await expect(oldQueued).rejects.toMatchObject({
            hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        });
        await newLifecycleWrite;
        await Promise.resolve();

        expect(callTrv).toHaveBeenCalledTimes(2);
        expect(callTrv).toHaveBeenNthCalledWith(2, 200, 'TRV.SetTarget', { id: 0, target_C: 22 });
        ability.destroy();
    });

    it('invalidates status on disconnect, refreshes on reconnect, and detaches listeners', async () => {
        const { component, gateway, rpcHandler, setConnected, setStatus } = createComponent({
            current_C: 20,
            target_C: 21,
            pos: 0,
            paired: true,
            rsv: 1,
            packet_id: 3,
            last_updated_ts: 100,
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);

        setConnected(false);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        setConnected(true);
        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        await setStatus('packet_id', 4);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.OFF);

        const rpcOffSpy = vi.spyOn(rpcHandler, 'off');
        const componentOffSpy = vi.spyOn(component, 'off');
        ability.detach();
        expect(rpcOffSpy).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(rpcOffSpy).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(componentOffSpy).toHaveBeenCalledWith('change:pos', expect.any(Function), ability);

        await setStatus('pos', 50);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.OFF);
        await expect(targetSetter(ability)(20)).rejects.toThrow('BLU TRV ability is detached');
    });

    it('restores identity from a timestamp-only delta after retained identity changes and returns', async () => {
        const { ability, target, rediscover } = await setupIdentitySnapshotFixture();

        // Hand the retained component to another peripheral, then back, with
        // no usable status in between.
        await rediscover({
            key: 'blutrv:200',
            status: {
                current_C: 29,
                target_C: 29,
                pos: 100,
                paired: true,
                rsv: 1,
                packet_id: 1,
                last_updated_ts: 1000,
                errors: [],
            },
            config: { addr: 'aa:bb:cc:dd:ee:ff' },
        });
        await rediscover({ key: 'blutrv:200', status: {}, config: { addr: TRV_ADDRESS } });
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        // A snapshot whose state markers all match the last seen B snapshot is
        // not evidence of a fresh observation.
        await rediscover({
            key: 'blutrv:200',
            status: {
                current_C: 20,
                target_C: 21,
                pos: 0,
                paired: true,
                rsv: 1,
                packet_id: 1,
                last_updated_ts: 1000,
                errors: [],
            },
            config: { addr: TRV_ADDRESS },
        });
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);
        expect(target.value).not.toBe(29);

        // A strictly newer last_updated_ts alone restores the identity.
        await rediscover({
            key: 'blutrv:200',
            status: {
                current_C: 20,
                target_C: 21,
                pos: 0,
                paired: true,
                rsv: 1,
                packet_id: 1,
                last_updated_ts: 1001,
                errors: [],
            },
            config: { addr: TRV_ADDRESS },
        });
        expect(target.statusCode).toBe(HAPStatus.SUCCESS);
        expect(target.value).toBe(21);
        ability.detach();
    });

    it('restores identity from a packet-only delta after retained identity changes and returns', async () => {
        const { ability, target, rediscover } = await setupIdentitySnapshotFixture();

        await rediscover({
            key: 'blutrv:200',
            status: {
                current_C: 29,
                target_C: 29,
                pos: 100,
                paired: true,
                rsv: 1,
                packet_id: 1,
                last_updated_ts: 1000,
                errors: [],
            },
            config: { addr: 'aa:bb:cc:dd:ee:ff' },
        });
        await rediscover({ key: 'blutrv:200', status: {}, config: { addr: TRV_ADDRESS } });
        expect(target.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        // A changed packet_id alone restores the identity; the timestamp is
        // deliberately identical to the baseline snapshot.
        await rediscover({
            key: 'blutrv:200',
            status: {
                current_C: 20,
                target_C: 21,
                pos: 0,
                paired: true,
                rsv: 1,
                packet_id: 2,
                last_updated_ts: 1000,
                errors: [],
            },
            config: { addr: TRV_ADDRESS },
        });
        expect(target.statusCode).toBe(HAPStatus.SUCCESS);
        expect(target.value).toBe(21);
        ability.detach();
    });

    it('treats a paired TRV without an rsv field as having a valid state version', async () => {
        const { component, gateway, setStatus } = createComponent({
            current_C: 20,
            target_C: 21,
            pos: 0,
            paired: true,
        });
        const { ability, service } = setupAbility(component, gateway);
        const currentState = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
        const targetTemperature = service.getCharacteristic(Characteristic.TargetTemperature);

        expect(currentState.statusCode).toBe(HAPStatus.RESOURCE_BUSY);

        // Older/partial firmware never sends rsv; `paired` and the reported
        // fields remain the available evidence, so a fresh packet publishes.
        await setStatus('packet_id', 1);
        expect(currentState.statusCode).toBe(HAPStatus.SUCCESS);
        expect(currentState.value).toBe(Characteristic.CurrentHeatingCoolingState.OFF);
        expect(targetTemperature.value).toBe(21);
        ability.detach();
    });
});
