import { DynamicComponent, ShellyBluGatewayGen3 } from '@lucavb/shellies-ds9';
import type { PlatformAccessory } from 'homebridge';

import { Accessory } from '../accessory.ts';
import type { Ability } from '../abilities/base.ts';
import { AccessoryInformationAbility } from '../abilities/accessory-information.ts';
import { BTHomeButtonAbility } from '../abilities/bthome-button.ts';
import { BTHomeSensorAbility } from '../abilities/bthome-sensor.ts';
import { BluTrvAbility, bluTrvServiceSubtype, parseBluTrvId } from '../abilities/blu-trv.ts';
import { ServiceLabelAbility } from '../abilities/service-label.ts';
import { DeviceDelegate } from './base.ts';
import type { Device } from '@lucavb/shellies-ds9';
import {
    getBTHomeSensorKind,
    getBTHomeLastUpdatedTimestamp,
    getKnownBTHomeButtonIndexes,
    groupBTHomeComponents,
    parseBTHomeAddress,
    parseBTHomeSensorConfig,
} from '../utils/bthome.ts';
import type { BTHomePeripheral } from '../utils/bthome.ts';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * ds9 exposes no inventory-change event, so a host without any BTHome
 * component still has to re-probe occasionally for newly paired peripherals.
 * A 30 minute cadence trades discovery latency for far less RPC noise.
 */
const EMPTY_INVENTORY_REPROBE_MS = 30 * 60 * 1000;

interface Binding {
    component: DynamicComponent;
    ability: BTHomeSensorAbility | BTHomeButtonAbility;
}

interface ManagedPeripheral {
    accessory: BTHomeAccessory;
    bindings: Map<string, Binding>;
    trvs: Map<string, TrvBinding>;
}

interface DesiredPeripheral {
    address: string;
    peripheral: BTHomePeripheral;
    /**
     * Known button indexes, or `undefined` when the peripheral's button
     * capabilities could not be queried. `undefined` means "retain the
     * existing button services unchanged"; only a successful query may add
     * or remove buttons.
     */
    buttonIndexes: number[] | undefined;
    trvs: TrvComponent[];
}

interface TrvComponent {
    component: DynamicComponent;
    id: number;
    address: string;
}

interface TrvBinding extends TrvComponent {
    ability: BluTrvAbility;
}

interface DelegateState {
    timer?: ReturnType<typeof setInterval>;
    timerInterval?: number;
    refresh?: Promise<void>;
    detached: boolean;
    generation: number;
    /** A warn about a failed refresh was emitted since the last success. */
    warnedRefreshFailure: boolean;
    peripherals: Map<string, ManagedPeripheral>;
}

const states = new WeakMap<BTHomeHostDelegate, DelegateState>();

/** Stable Homebridge accessory wrapper for one verified BLE address. */
class BTHomeAccessory extends Accessory {
    constructor(
        id: string,
        readonly device: Device,
        readonly hostId: string,
        readonly peripheralAddress: string,
        name: string,
        platform: ConstructorParameters<typeof Accessory>[3],
        log: ConstructorParameters<typeof Accessory>[4],
        validSubtypes: Set<string>,
        ...abilities: Ability[]
    ) {
        const informationAbility = new AccessoryInformationAbility(device);
        super(id, peripheralAddress, name, platform, log, informationAbility, ...abilities);
        this.informationAbility = informationAbility;
        // The delegate can pass a fresh label ability at construction; the
        // stable field below is the identity reconcileAbilities must keep
        // seeing, or the service is removed and re-added on the next cycle.
        const labelIndex = this.abilities.findIndex((ability) => ability instanceof ServiceLabelAbility);
        if (labelIndex !== -1) {
            this.abilities[labelIndex] = this.serviceLabelAbility;
        }
        const cachedAccessory = platform.getAccessory(this.uuid);
        if (cachedAccessory) {
            const cachedDevice = cachedAccessory.context.device as Record<string, unknown> | undefined;
            cachedAccessory.context.device = {
                ...cachedDevice,
                id: hostId,
                bthomeAddress: peripheralAddress,
            };
            this.removeStaleServices(validSubtypes);
        }
    }

    private readonly informationAbility: AccessoryInformationAbility;

    /** Stable ServiceLabel instance so the service survives ability reconciles. */
    readonly serviceLabelAbility = new ServiceLabelAbility('arabicNumerals');

    reconcileHostedPeripheralAbilities(...abilities: Ability[]) {
        this.reconcileAbilities(this.informationAbility, ...abilities);
    }

    protected createPlatformAccessory(): PlatformAccessory {
        const accessory = super.createPlatformAccessory();
        accessory.context.device = { id: this.hostId, bthomeAddress: this.peripheralAddress };
        return accessory;
    }

    removeStaleServices(validSubtypes: Set<string>) {
        const accessory = this.platform.getAccessory(this.uuid);
        if (!accessory) {
            return;
        }
        for (const service of [...accessory.services]) {
            if (
                (service.subtype?.startsWith('bthome-') || service.subtype?.startsWith('blu-trv-')) &&
                !validSubtypes.has(service.subtype)
            ) {
                accessory.removeService(service);
            }
        }
    }
}

/**
 * Discovers and manages hosted BTHome peripherals and BLU TRVs for one Shelly RPC device.
 * ds9 1.9.0 has no inventory-change event, so this refreshes on connect and
 * periodically. Incomplete metadata or failed capability queries are non-authoritative.
 */
export class BTHomeHostDelegate extends DeviceDelegate {
    /**
     * This delegate shadows the device's primary delegate; the primary already
     * logs the shared device lifecycle, so the companion stays quiet.
     */
    protected lifecycleLogging(): boolean {
        return false;
    }

    protected setup() {
        if (!this.platform.options.bthome.enable) {
            return;
        }
        states.set(this, {
            detached: false,
            generation: 0,
            warnedRefreshFailure: false,
            peripherals: new Map(),
        });
        void this.refreshInventory().finally(() => {
            // refreshBTHomeInventory picks the cadence on success; after a failed
            // initial refresh, fall back to the normal interval.
            const state = states.get(this);
            if (!state?.timer) {
                this.scheduleRefresh(REFRESH_INTERVAL_MS);
            }
        });
    }

    /** The normal delegate owns built-in Sensor Add-on accessories. */
    protected setupAddonSensors() {}

    protected handleConnect() {
        super.handleConnect();
        if (this.platform.options.bthome.enable) {
            void this.refreshInventory();
        }
    }

    protected handleDisconnect(code: number, reason: string, reconnectIn: number | null) {
        super.handleDisconnect(code, reason, reconnectIn);
        for (const managed of states.get(this)?.peripherals.values() ?? []) {
            for (const binding of managed.bindings.values()) {
                if (binding.ability instanceof BTHomeSensorAbility) {
                    binding.ability.markDisconnected();
                }
            }
        }
        this.platform.markBTHomeAccessoriesUnavailable(this.device.id);
    }

    private scheduleRefresh(intervalMs: number) {
        const state = states.get(this);
        if (!state || state.detached || !this.platform.options.bthome.enable) {
            return;
        }
        if (state.timer) {
            if (state.timerInterval === intervalMs) {
                return;
            }
            clearInterval(state.timer);
        }
        // Reconnecting already triggers a refresh via handleConnect, so a
        // disconnected host must not poll (and warn) into the void.
        state.timer = setInterval(() => {
            if (!this.connected) {
                return;
            }
            void this.refreshInventory();
        }, intervalMs);
        state.timerInterval = intervalMs;
        state.timer.unref?.();
    }

    private refreshInventory(): Promise<void> {
        const state = states.get(this);
        if (!state || state.detached || !this.platform.options.bthome.enable) {
            return Promise.resolve();
        }
        if (state.refresh) {
            return state.refresh;
        }

        const refresh = this.refreshBTHomeInventory(state)
            .then(() => {
                state.warnedRefreshFailure = false;
            })
            .catch((error: unknown) => {
                if (state.detached) {
                    return;
                }
                const message = error instanceof Error ? error.message : error;
                // Polling failures are routine for sleeping/offline hosts; warn
                // once until a refresh succeeds again, and stay quiet otherwise.
                this.log.debug('Failed to refresh hosted BTHome components:', message);
                if (!state.warnedRefreshFailure) {
                    state.warnedRefreshFailure = true;
                    this.log.warn('Failed to refresh hosted BTHome components:', message);
                }
            });
        const wrapped = refresh.finally(() => {
            if (state.refresh === wrapped) {
                state.refresh = undefined;
            }
        });
        state.refresh = wrapped;
        return wrapped;
    }

    private async refreshBTHomeInventory(state: DelegateState) {
        // ds9 validates the complete Shelly.GetComponents page set before it
        // reconciles its internal component map. A thrown request is non-authoritative.
        await this.device.refreshBTHomeComponents();
        if (state.detached) {
            return;
        }

        const components: DynamicComponent[] = [];
        let complete = true;
        let bthomeComponentCount = 0;
        for (const [key, component] of this.device) {
            if (/^(?:bthomedevice|bthomesensor|blutrv)(?::|$)/i.test(key)) {
                bthomeComponentCount++;
            }
            if (component instanceof DynamicComponent) {
                components.push(component);
            } else if (/^(?:bthome(?:device|sensor)|blutrv)(?::|$)/i.test(key)) {
                complete = false;
            }
        }

        // ds9 emits no inventory-change event, so component presence is only
        // learned by polling. Any BTHome component restores the normal
        // five-minute cadence; a complete inventory without any BTHome
        // component drops to the slower re-probe interval so newly paired
        // peripherals still appear without a restart.
        if (bthomeComponentCount > 0) {
            this.scheduleRefresh(REFRESH_INTERVAL_MS);
        } else if (complete) {
            this.scheduleRefresh(EMPTY_INVENTORY_REPROBE_MS);
        }

        const trvsByAddress = new Map<string, TrvComponent[]>();
        const trvIds = new Set<number>();

        // Any hosted component whose identity/config tuple is missing makes
        // this inventory ambiguous; do not delete or mutate accessories from it.
        for (const component of components) {
            if (/^bthomedevice:\d+$/i.test(component.key)) {
                if (parseBTHomeAddress(component.config?.addr) === undefined) {
                    complete = false;
                }
            } else if (/^bthomesensor:\d+$/i.test(component.key)) {
                if (parseBTHomeSensorConfig(component) === undefined) {
                    complete = false;
                }
            } else if (/^blutrv(?::|$)/i.test(component.key)) {
                const id = parseBluTrvId(component.key);
                const address = parseBTHomeAddress(component.config?.addr);
                if (id === undefined || address === undefined || trvIds.has(id)) {
                    complete = false;
                    continue;
                }
                trvIds.add(id);

                // An explicit unpaired status removes this TRV from the desired
                // set. Its address is still validated so malformed inventory
                // cannot cause stale-service deletion.
                if (component.status.paired === false) {
                    continue;
                }
                const trvs = trvsByAddress.get(address) ?? [];
                trvs.push({ component, id, address });
                trvsByAddress.set(address, trvs);
            }
        }
        if (trvsByAddress.size > 0 && !this.getBluGateway()) {
            complete = false;
        }
        if (!complete) {
            this.log.debug('Keeping hosted accessories because component metadata is incomplete');
            return;
        }

        if (Array.from(trvsByAddress.values()).some((trvs) => trvs.length > 1)) {
            this.log.debug('Keeping hosted accessories because a BLE address has ambiguous TRV components');
            return;
        }

        const grouped = groupBTHomeComponents(components);
        const desired = new Map<string, DesiredPeripheral>();
        // A failed or malformed button capability query for one peripheral must
        // not freeze the reconcile for the whole host: that peripheral keeps its
        // existing button services, and the stale-accessory sweep below is
        // skipped for this cycle because the inventory is not authoritative.
        let capabilitiesComplete = true;
        for (const peripheral of grouped.values()) {
            if (peripheral.devices.length > 1) {
                this.log.debug(
                    `Keeping BTHome accessories because ${peripheral.address} has ambiguous device components`,
                );
                return;
            }

            let buttonIndexes: number[] | undefined;
            let capabilityFailed = false;
            const deviceComponent = peripheral.devices[0];
            if (deviceComponent) {
                const componentId = Number(deviceComponent.key.split(':')[1]);
                let response: unknown;
                try {
                    response = await deviceComponent.call('GetKnownObjects', { id: componentId });
                } catch {
                    if (state.detached) {
                        return;
                    }
                    this.log.debug(
                        `Keeping existing BTHome buttons because button capabilities for ${peripheral.address} are unavailable`,
                    );
                    capabilityFailed = true;
                }
                if (state.detached) {
                    return;
                }
                if (!capabilityFailed) {
                    const indexes = getKnownBTHomeButtonIndexes(response);
                    if (indexes === undefined) {
                        this.log.debug(
                            `Keeping existing BTHome buttons because button capabilities for ${peripheral.address} are malformed`,
                        );
                        capabilityFailed = true;
                    } else {
                        buttonIndexes = indexes;
                    }
                }
            } else if (state.peripherals.get(peripheral.address)?.bindings.size) {
                // A previously managed peripheral unexpectedly lost its parent
                // component while child metadata remains; this is not an unpair proof.
                this.log.debug(`Keeping BTHome accessories because ${peripheral.address} has no device component`);
                return;
            }
            if (capabilityFailed) {
                capabilitiesComplete = false;
            }

            desired.set(peripheral.address, {
                address: peripheral.address,
                peripheral,
                buttonIndexes,
                trvs: trvsByAddress.get(peripheral.address) ?? [],
            });
        }

        for (const [address, trvs] of trvsByAddress) {
            if (!desired.has(address)) {
                desired.set(address, {
                    address,
                    peripheral: { address, devices: [], sensors: [] },
                    buttonIndexes: [],
                    trvs,
                });
            }
        }

        if (state.detached) {
            return;
        }

        const generation = ++state.generation;

        // Non-destructive reconcile always runs: a peripheral whose button
        // capabilities could not be queried still reconciles its sensors/TRVs,
        // and other peripherals reconcile normally.
        for (const [address, entry] of desired) {
            try {
                this.reconcilePeripheral(address, entry, state, generation);
            } catch (error) {
                // One peripheral (e.g. a TRV rebind racing a concurrent
                // rediscovery) must not abort the rest of the cycle.
                this.log.warn(`Failed to reconcile hosted BTHome peripheral ${address}:`, error);
            }
        }

        // A complete, parsed inventory is authoritative for cached addresses.
        // This also handles startup while a peripheral was unpaired. When any
        // peripheral's button capabilities could not be queried, the inventory
        // is not authoritative enough to remove anything: keep every managed
        // peripheral and cached accessory until the next complete refresh.
        if (!capabilitiesComplete) {
            this.log.debug('Keeping hosted accessories because button capabilities are incomplete');
            return;
        }

        const removedManaged = new Set<string>();
        for (const address of state.peripherals.keys()) {
            if (!desired.has(address)) {
                this.removePeripheral(address, state);
                removedManaged.add(address);
            }
        }

        for (const accessory of this.platform.getBTHomeAccessories(this.device.id)) {
            const context = accessory.context.device as { bthomeAddress?: unknown } | undefined;
            const address = parseBTHomeAddress(context?.bthomeAddress);
            if (address === undefined || desired.has(address) || removedManaged.has(address)) {
                continue;
            }
            const owner = this.platform.bthomePeripheralOwners.get(address);
            if (owner !== undefined && owner !== this.device.id) {
                continue;
            }
            this.platform.removeAccessory(accessory);
            this.platform.releaseBTHomePeripheral(address, this.device.id);
        }
    }

    private reconcilePeripheral(address: string, entry: DesiredPeripheral, state: DelegateState, generation: number) {
        const accessoryId = `bthome-${address}`;
        const previous = state.peripherals.get(address);
        const bindings = new Map<string, Binding>();
        const trvs = new Map<string, TrvBinding>();

        for (const { component, config } of entry.peripheral.sensors) {
            const kind = getBTHomeSensorKind(config.objectId);
            if (kind === undefined) {
                continue;
            }
            const key = `sensor:${config.objectId}:${config.index}`;
            const old = previous?.bindings.get(key);
            const ability =
                old?.component === component &&
                old.ability instanceof BTHomeSensorAbility &&
                old.ability.address === address &&
                old.ability.objectId === config.objectId &&
                old.ability.index === config.index
                    ? old.ability
                    : new BTHomeSensorAbility(component, kind, config.objectId, config.index, address);
            bindings.set(key, { component, ability });
        }

        const deviceComponent = entry.peripheral.devices[0];
        if (deviceComponent) {
            // `buttonIndexes === undefined` means capability discovery failed or
            // was malformed: keep this peripheral's existing button services
            // exactly as-is (no additions, no removals) for this cycle.
            const indexes =
                entry.buttonIndexes ??
                Array.from(previous?.bindings.keys() ?? [])
                    .filter((key) => key.startsWith('button:'))
                    .map((key) => Number(key.slice('button:'.length)));
            for (const index of indexes) {
                const key = `button:${index}`;
                const old = previous?.bindings.get(key);
                const ability =
                    old?.component === deviceComponent &&
                    old.ability instanceof BTHomeButtonAbility &&
                    old.ability.address === address
                        ? old.ability
                        : new BTHomeButtonAbility(deviceComponent, index, address);
                bindings.set(key, { component: deviceComponent, ability });
            }
        }

        let retainedButtonSubtypes: Set<string> | undefined;
        if (entry.buttonIndexes === undefined && deviceComponent !== undefined) {
            // This cycle's capability query failed, so the button inventory
            // is non-authoritative. Managed buttons re-bind above; after a
            // restart the cached button subtypes must at least survive the
            // stale-service sweep until a successful query re-reconciles them.
            retainedButtonSubtypes = new Set(this.getCachedButtonSubtypes(address));
        }

        if (deviceComponent === undefined && previous !== undefined && previous.bindings.size > 0) {
            // A previously managed peripheral that lost its parent device
            // component while child metadata remains (its TRVs, via a
            // TRV-only inventory entry) is not an unpair proof: keep its
            // existing bindings so their services survive this cycle.
            for (const [bindingKey, binding] of previous.bindings) {
                if (!bindings.has(bindingKey)) {
                    bindings.set(bindingKey, binding);
                }
            }
        }

        // Any TRV-bearing entry implies gateway support: refreshBTHomeInventory
        // refuses to reconcile an inventory whose TRVs sit on a host without
        // callTrv, so the non-null assertions below hold by construction.
        const gateway = this.getBluGateway();
        for (const trv of entry.trvs) {
            const old = previous?.trvs.get(trv.address);
            let ability: BluTrvAbility;
            if (old) {
                ability = old.ability;
                if (old.component !== trv.component || old.id !== trv.id) {
                    ability.rebind(trv.component, gateway!, trv.id);
                }
            } else {
                ability = new BluTrvAbility(trv.component, gateway!, trv.id, trv.address);
            }
            trvs.set(trv.address, { ...trv, ability });
        }

        const abilities: Ability[] = [
            ...Array.from(bindings.values(), ({ ability }) => ability),
            ...Array.from(trvs.values(), ({ ability }) => ability),
        ];
        // Grouped BTHome buttons expect a ServiceLabel service, mirroring how
        // the shelly-plus-i4 delegate wires one up.
        if (abilities.some((ability) => ability instanceof BTHomeButtonAbility)) {
            abilities.push(previous?.accessory.serviceLabelAbility ?? new ServiceLabelAbility('arabicNumerals'));
        }
        const validSubtypes = this.getValidServiceSubtypes(bindings, trvs);
        if (retainedButtonSubtypes) {
            for (const subtype of retainedButtonSubtypes) {
                validSubtypes.add(subtype);
            }
        }
        let accessory: BTHomeAccessory;

        if (previous) {
            accessory = previous.accessory;
            accessory.reconcileHostedPeripheralAbilities(...abilities);
            accessory.removeStaleServices(validSubtypes);
        } else {
            const cached = this.platform.getBTHomeAccessories(this.device.id).some((candidate) => {
                const context = candidate.context.device as { bthomeAddress?: unknown } | undefined;
                return parseBTHomeAddress(context?.bthomeAddress) === address;
            });
            if (abilities.length === 0 && !cached) {
                return;
            }
            if (!this.platform.claimBTHomePeripheral(address, this.device.id)) {
                this.log.debug(`BTHome peripheral ${address} is already represented by another host`);
                return;
            }

            const deviceName = this.options.name || this.device.modelName;
            const peripheralName = this.getPeripheralName(entry) || address;
            const fallbackModel =
                entry.trvs.length > 0 && entry.peripheral.sensors.length === 0 && entry.peripheral.devices.length === 0
                    ? 'BLU TRV'
                    : 'BTHome sensor';
            accessory = new BTHomeAccessory(
                accessoryId,
                // Peripherals get their own identity instead of the host's:
                // SerialNumber is the BLE address, Model the peripheral name.
                {
                    modelName: peripheralName === address ? fallbackModel : peripheralName,
                    macAddress: address,
                    firmware: { version: '' },
                } as unknown as Device,
                this.device.id,
                address,
                `${deviceName} ${peripheralName}`,
                this.platform,
                this.log,
                validSubtypes,
                ...abilities,
            );
            this.accessories.set(accessoryId, accessory);
        }

        state.peripherals.set(address, { accessory, bindings, trvs });

        if (!this.connected) {
            for (const binding of bindings.values()) {
                if (binding.ability instanceof BTHomeSensorAbility) {
                    binding.ability.markDisconnected();
                }
            }
            return;
        }

        // GetStatus may return Shelly's cached value. The ability requires a
        // strictly newer `last_update_ts` after disconnect before restoring it.
        for (const [bindingKey, binding] of bindings) {
            if (!(binding.ability instanceof BTHomeSensorAbility)) {
                continue;
            }
            const ability = binding.ability;
            const requestVersion = ability.valueVersion;
            const isCurrent = () => this.isCurrentBinding(state, address, bindingKey, binding, generation);
            // Accessory activation is queued before this timer. This hydrates
            // cached freshness markers before any cached GetStatus response can
            // be considered for recovery.
            setTimeout(() => {
                if (!isCurrent()) {
                    return;
                }
                void Promise.resolve()
                    .then(() => {
                        if (!isCurrent()) {
                            return undefined;
                        }
                        return binding.component.getStatus<Record<string, unknown>>();
                    })
                    .then((status) => {
                        if (!isCurrent() || status === undefined || status === null) {
                            return;
                        }
                        if (!this.connected) {
                            ability.markDisconnected();
                            return;
                        }
                        if (ability.valueVersion !== requestVersion) {
                            return;
                        }
                        if (Object.hasOwn(status, 'value')) {
                            const timestamp = getBTHomeLastUpdatedTimestamp(status);
                            if (timestamp === null) {
                                ability.markUnavailable();
                            } else {
                                ability.observeStatus(status.value, timestamp);
                            }
                        } else {
                            ability.markUnavailable();
                        }
                    })
                    .catch((error: unknown) => {
                        try {
                            if (isCurrent()) {
                                ability.markUnavailable();
                            }
                        } catch (cleanupError) {
                            this.log.debug(
                                'Failed to mark an unavailable BTHome reading:',
                                cleanupError instanceof Error ? cleanupError.message : error,
                            );
                        }
                    });
            }, 0);
        }
    }

    private isCurrentBinding(
        state: DelegateState,
        address: string,
        key: string,
        binding: Binding,
        generation: number,
    ): boolean {
        if (state.detached || state.generation !== generation) {
            return false;
        }
        if (state.peripherals.get(address)?.bindings.get(key) !== binding) {
            return false;
        }
        if (binding.ability instanceof BTHomeSensorAbility || binding.ability instanceof BTHomeButtonAbility) {
            if (!binding.ability.isCurrentComponentIdentity()) {
                return false;
            }
        }
        return this.device.getComponent(binding.component.key) === binding.component;
    }
    private getValidServiceSubtypes(bindings: Map<string, Binding>, trvs: Map<string, TrvBinding>): Set<string> {
        // Collected from the abilities themselves so the stale-service sweep
        // can never disagree with the services those abilities manage.
        const valid = new Set<string>();
        for (const { ability } of bindings.values()) {
            if (ability.serviceSubtype !== undefined) {
                valid.add(ability.serviceSubtype);
            }
        }
        for (const address of trvs.keys()) {
            valid.add(bluTrvServiceSubtype(address));
        }
        return valid;
    }

    /**
     * Subtypes of the button services already persisted for this peripheral.
     * A failed capability query cannot describe them, but they must not be
     * mistaken for stale services either.
     */
    private getCachedButtonSubtypes(address: string): string[] {
        const cached = this.platform
            .getBTHomeAccessories(this.device.id)
            .find(
                (candidate) =>
                    parseBTHomeAddress(
                        (candidate.context.device as { bthomeAddress?: unknown } | undefined)?.bthomeAddress,
                    ) === address,
            );
        const subtypes: string[] = [];
        for (const service of cached?.services ?? []) {
            if (/^bthome-button-\d+$/.test(service.subtype ?? '')) {
                subtypes.push(service.subtype!);
            }
        }
        return subtypes;
    }

    private getPeripheralName(entry: DesiredPeripheral): string | undefined {
        const components = [
            ...entry.peripheral.devices,
            ...entry.peripheral.sensors.map(({ component }) => component),
            ...entry.trvs.map(({ component }) => component),
        ];
        for (const component of components) {
            const name = component.config?.name;
            if (typeof name === 'string' && name.trim().length > 0) {
                return name.trim();
            }
        }
        return undefined;
    }

    private getBluGateway(): ShellyBluGatewayGen3 | undefined {
        const device = this.device as Device & { callTrv?: ShellyBluGatewayGen3['callTrv'] };
        return typeof device.callTrv === 'function' ? (device as ShellyBluGatewayGen3) : undefined;
    }

    private removePeripheral(address: string, state: DelegateState) {
        const managed = state.peripherals.get(address);
        if (!managed) {
            return;
        }
        state.peripherals.delete(address);
        this.accessories.delete(managed.accessory.id);
        managed.accessory.setActive(false);
        this.platform.releaseBTHomePeripheral(address, this.device.id);
    }

    /** Non-destructive lifecycle teardown used on shutdown; accessories remain registered. */
    detach() {
        const state = states.get(this);
        if (state) {
            state.detached = true;
            state.generation++;
            if (state.timer) {
                clearInterval(state.timer);
                state.timer = undefined;
            }
        }
        super.detach();
    }

    destroy() {
        const state = states.get(this);
        this.detach();
        if (state) {
            for (const address of state.peripherals.keys()) {
                this.platform.releaseBTHomePeripheral(address, this.device.id);
            }
        }
        states.delete(this);
        super.destroy();
    }
}

/** HomeKit support for Shelly BLU Gateway Gen3's hosted BTHome peripherals. */
export class ShellyBluGatewayDelegate extends BTHomeHostDelegate {}

DeviceDelegate.registerDelegate(ShellyBluGatewayDelegate, ShellyBluGatewayGen3);
