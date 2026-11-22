import { DynamicComponent } from '@lucavb/shellies-ds9';
import { Categories } from 'homebridge';
import type { Characteristic, CharacteristicGetCallback, WithUUID } from 'homebridge';

import { Ability, ServiceClass } from './base.ts';
import {
    bthomeSensorKindDescriptors,
    getBTHomeLastUpdatedTimestamp,
    parseBTHomeSensorConfig,
} from '../utils/bthome.ts';
import type { BTHomeSensorKind } from '../utils/bthome.ts';

type HomeKitCharacteristic = WithUUID<new () => Characteristic> & WithUUID<typeof Characteristic>;

interface PendingObservation {
    value: unknown;
    timestamp: number | null | undefined;
}

/** Exposes one supported BTHome datapoint as a HomeKit sensor service. */
export class BTHomeSensorAbility extends Ability {
    private observedValue: unknown;
    private initialized = false;
    private observationVersion = 0;
    private explicitlyUnavailable = false;
    private lastUpdatedTimestamp?: number;
    private disconnectTimestamp?: number;
    private requiresNewerTimestamp = false;
    private lifecycleGeneration = 0;
    private statusObservationScheduled = false;
    private readonly pendingObservations: PendingObservation[] = [];
    private readonly getHandlers = new Map<Characteristic, (callback: CharacteristicGetCallback) => void>();

    constructor(
        readonly component: DynamicComponent,
        readonly kind: BTHomeSensorKind,
        readonly objectId: number,
        readonly index: number,
        readonly address: string,
    ) {
        super(`${BTHomeSensorAbility.displayName(kind)} ${index + 1}`, `bthome-${kind}-${objectId}-${index}`);
    }

    static displayName(kind: BTHomeSensorKind): string {
        return bthomeSensorKindDescriptors[kind].displayName;
    }

    get category(): Categories {
        return Categories.SENSOR;
    }

    protected get serviceClass(): ServiceClass {
        return this.Service[bthomeSensorKindDescriptors[this.kind].serviceName] as unknown as ServiceClass;
    }

    /** Resolves a HAP characteristic constructor recorded in the kind descriptor table. */
    private kindCharacteristic(
        name: (typeof bthomeSensorKindDescriptors)[BTHomeSensorKind]['characteristics'][number],
    ): HomeKitCharacteristic {
        return this.Characteristic[name] as unknown as HomeKitCharacteristic;
    }

    protected initialize() {
        const descriptor = bthomeSensorKindDescriptors[this.kind];
        this.lifecycleGeneration++;
        if (this.kind === 'temperature') {
            this.service.getCharacteristic(this.kindCharacteristic('CurrentTemperature')).setProps({
                minValue: -100,
                maxValue: 125,
                minStep: 0.01,
            });
        } else if (this.kind === 'humidity') {
            this.service
                .getCharacteristic(this.kindCharacteristic('CurrentRelativeHumidity'))
                .setProps({ minStep: 0.01 });
        } else if (this.kind === 'battery') {
            this.service.getCharacteristic(this.kindCharacteristic('BatteryLevel')).setProps({
                minValue: 0,
                maxValue: 100,
                minStep: 1,
            });
            // BTHome reports percentage, not charging state.
            this.removeCharacteristic(this.Characteristic.ChargingState);
            // The percentage object provides no documented low-battery threshold or flag.
            this.updateUnavailable(this.service.getCharacteristic(this.kindCharacteristic('StatusLowBattery')));
        }

        for (const name of descriptor.characteristics) {
            this.addIdentityGuardedGet(this.service.getCharacteristic(this.kindCharacteristic(name)));
        }

        const freshness = this.getPersistedFreshness();
        if (typeof freshness.lastUpdatedTimestamp === 'number' && Number.isFinite(freshness.lastUpdatedTimestamp)) {
            this.lastUpdatedTimestamp = freshness.lastUpdatedTimestamp;
        }
        if (freshness.unavailable) {
            this.requiresNewerTimestamp = true;
            this.disconnectTimestamp = this.lastUpdatedTimestamp;
            this.explicitlyUnavailable = true;
        }
        const componentTimestamp = getBTHomeLastUpdatedTimestamp(this.component.status);
        if (componentTimestamp === null) {
            this.observedValue = undefined;
            this.explicitlyUnavailable = true;
        } else if (componentTimestamp !== undefined) {
            this.updateLastUpdatedTimestamp(componentTimestamp);
            if (this.requiresNewerTimestamp && this.disconnectTimestamp === undefined) {
                this.disconnectTimestamp = componentTimestamp;
            }
        }
        if (
            !this.explicitlyUnavailable &&
            this.observedValue === undefined &&
            Object.hasOwn(this.component.status, 'value')
        ) {
            this.observedValue = this.component.status.value;
        }
        this.initialized = true;
        this.persistFreshness(this.requiresNewerTimestamp);
        this.updateValue(this.observedValue);
        this.component
            .on('change:value', this.valueChangeHandler, this)
            .on('change:last_update_ts', this.timestampChangeHandler, this)
            .on('change:last_updated_ts', this.timestampChangeHandler, this);
    }

    detach() {
        for (const [characteristic, handler] of this.getHandlers) {
            characteristic.off('get', handler);
        }
        this.getHandlers.clear();
        this.component
            .off('change:value', this.valueChangeHandler, this)
            .off('change:last_update_ts', this.timestampChangeHandler, this)
            .off('change:last_updated_ts', this.timestampChangeHandler, this);
        this.initialized = false;
        this.lifecycleGeneration++;
        this.statusObservationScheduled = false;
        this.pendingObservations.length = 0;
    }

    private addIdentityGuardedGet(characteristic: Characteristic) {
        const handler = (callback: CharacteristicGetCallback) => {
            if (!this.initialized || !this.isCurrentComponentIdentity()) {
                callback(this.api.hap.HAPStatus.RESOURCE_BUSY);
                return;
            }
            const statusCode = characteristic.statusCode;
            if (
                (statusCode !== undefined && statusCode !== this.api.hap.HAPStatus.SUCCESS) ||
                characteristic.value === null ||
                characteristic.value === undefined
            ) {
                callback(this.api.hap.HAPStatus.RESOURCE_BUSY);
                return;
            }
            callback(null, characteristic.value);
        };
        characteristic.on('get', handler);
        this.getHandlers.set(characteristic, handler);
    }

    /** Accepts a value from an actual Shelly status response or component update. */
    private observe(value: unknown, timestamp?: unknown) {
        this.observedValue = value;
        this.explicitlyUnavailable = false;
        this.updateLastUpdatedTimestamp(timestamp);
        this.requiresNewerTimestamp = false;
        this.disconnectTimestamp = undefined;
        this.persistFreshness(false);
        this.observationVersion++;
        if (this.initialized) {
            this.updateValue(value);
        }
    }

    get valueVersion(): number {
        return this.observationVersion;
    }

    /**
     * Applies a GetStatus response. After a disconnect it is accepted only if
     * Shelly reports a strictly newer `last_update_ts` than the last observation.
     * No maximum-age rule is applied; the library typings do not declare the
     * field, so no timestamp freshness/age contract exists. A host that
     * reports no timestamp at all cannot have a watermark, so the first
     * observation after a disconnect is published directly (a cached reading
     * is indistinguishable from a live one for such hosts).
     */
    observeStatus(value: unknown, timestamp: unknown): boolean {
        if (this.requiresNewerTimestamp && this.disconnectTimestamp === undefined) {
            if (timestamp === undefined) {
                // The host reports no timestamp at all, so no watermark can
                // ever exist: waiting for one would keep the sensor
                // unavailable forever. Without a timestamp there is also no
                // way to tell a live report from a cached one; publishing it
                // is the only freshness evidence available.
                this.observe(value, timestamp);
                return true;
            }
            if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
                return false;
            }
            // A persisted unavailable marker may not have its matching
            // timestamp. Use the first valid packet only as a baseline.
            this.disconnectTimestamp = timestamp;
            this.updateLastUpdatedTimestamp(timestamp);
            this.persistFreshness(true);
            return false;
        }
        if (
            this.requiresNewerTimestamp &&
            (this.disconnectTimestamp === undefined ||
                typeof timestamp !== 'number' ||
                !Number.isFinite(timestamp) ||
                timestamp <= this.disconnectTimestamp)
        ) {
            return false;
        }
        this.observe(value, timestamp);
        return true;
    }

    /** Marks the reading unavailable without removing its HomeKit service. */
    markUnavailable() {
        this.observedValue = undefined;
        this.explicitlyUnavailable = true;
        this.observationVersion++;
        if (this.initialized) {
            this.updateValue(undefined);
            // Persist the marker like markDisconnected() does, so a stale cached
            // value cannot resurface as live after a restart.
            this.persistFreshness(true);
        }
    }

    /** Marks a disconnection, retaining the last timestamp as a recovery watermark. */
    markDisconnected() {
        this.lifecycleGeneration++;
        this.statusObservationScheduled = false;
        this.pendingObservations.length = 0;
        this.disconnectTimestamp = this.lastUpdatedTimestamp;
        this.requiresNewerTimestamp = true;
        this.markUnavailable();
        this.persistFreshness(true);
    }

    /** True only while ds9's retained key still identifies this exact sensor. */
    isCurrentComponentIdentity(): boolean {
        const config = parseBTHomeSensorConfig(this.component);
        if (config?.address !== this.address || config.objectId !== this.objectId || config.index !== this.index) {
            return false;
        }
        return this.component.device.getComponent(this.component.key) === this.component;
    }

    private valueChangeHandler() {
        this.scheduleStatusObservation();
    }

    private timestampChangeHandler() {
        this.scheduleStatusObservation();
    }

    private scheduleStatusObservation() {
        if (!this.initialized || !Object.hasOwn(this.component.status, 'value')) {
            return;
        }
        const observation = {
            value: this.component.status.value,
            timestamp: getBTHomeLastUpdatedTimestamp(this.component.status),
        };
        const previous = this.pendingObservations[this.pendingObservations.length - 1];
        if (previous && Object.is(previous.value, observation.value) && previous.timestamp === observation.timestamp) {
            return;
        }
        this.pendingObservations.push(observation);
        if (this.statusObservationScheduled) {
            return;
        }
        this.statusObservationScheduled = true;
        const generation = this.lifecycleGeneration;
        queueMicrotask(() => {
            if (generation !== this.lifecycleGeneration) {
                return;
            }
            this.statusObservationScheduled = false;
            if (!this.initialized) {
                return;
            }
            const observations = this.pendingObservations.splice(0);
            for (const observation of observations) {
                if (!this.isCurrentComponentIdentity()) {
                    this.pendingObservations.length = 0;
                    this.markUnavailable();
                    return;
                }
                if (observation.timestamp === null) {
                    this.markUnavailable();
                } else {
                    // Resolve after the current synchronous ds9 notification stack:
                    // 1.9.0 updates status before replacing retained-key config.
                    this.observeStatus(observation.value, observation.timestamp);
                }
            }
        });
    }

    private updateLastUpdatedTimestamp(value: unknown) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            this.lastUpdatedTimestamp = value;
            this.persistFreshness(this.requiresNewerTimestamp);
        }
    }

    private getPersistedFreshness(): { lastUpdatedTimestamp?: number; unavailable: boolean } {
        const device = this.platformAccessory.context.device as Record<string, unknown> | undefined;
        const timestamps = device?.bthomeLastUpdatedTs as Record<string, unknown> | undefined;
        const unavailableServices = device?.bthomeUnavailableServices as Record<string, unknown> | undefined;
        const timestamp = this.serviceSubtype ? timestamps?.[this.serviceSubtype] : undefined;
        return {
            lastUpdatedTimestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined,
            unavailable: this.serviceSubtype !== undefined && unavailableServices?.[this.serviceSubtype] === true,
        };
    }

    private persistFreshness(unavailable: boolean) {
        if (!this.serviceSubtype || !this.initialized) {
            return;
        }
        const context = this.platformAccessory.context;
        let device = context.device as Record<string, unknown> | undefined;
        if (!device || typeof device !== 'object') {
            device = {};
            context.device = device as never;
        }
        const timestamps = (device.bthomeLastUpdatedTs as Record<string, unknown> | undefined) ?? {};
        const unavailableServices = (device.bthomeUnavailableServices as Record<string, unknown> | undefined) ?? {};
        if (this.lastUpdatedTimestamp !== undefined) {
            timestamps[this.serviceSubtype] = this.lastUpdatedTimestamp;
        }
        if (unavailable) {
            unavailableServices[this.serviceSubtype] = true;
        } else {
            unavailableServices[this.serviceSubtype] = false;
        }
        device.bthomeLastUpdatedTs = timestamps;
        device.bthomeUnavailableServices = unavailableServices;
    }

    private updateValue(value: unknown) {
        const characteristics = bthomeSensorKindDescriptors[this.kind].characteristics.map((name) =>
            this.service.getCharacteristic(this.kindCharacteristic(name)),
        );
        switch (this.kind) {
            case 'temperature':
                this.updateNumeric(characteristics[0], value, (reading) => reading >= -100 && reading <= 125);
                return;
            case 'humidity':
                this.updateNumeric(characteristics[0], value, (reading) => reading >= 0 && reading <= 100);
                return;
            case 'contact':
                if (value === 0 || value === false) {
                    characteristics[0].updateValue(this.Characteristic.ContactSensorState.CONTACT_DETECTED);
                } else if (value === 1 || value === true) {
                    characteristics[0].updateValue(this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
                } else {
                    this.updateUnavailable(characteristics[0]);
                }
                return;
            case 'motion':
                if (value === 0 || value === false) {
                    characteristics[0].updateValue(false);
                } else if (value === 1 || value === true) {
                    characteristics[0].updateValue(true);
                } else {
                    this.updateUnavailable(characteristics[0]);
                }
                return;
            case 'battery':
                if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
                    for (const characteristic of characteristics) {
                        this.updateUnavailable(characteristic);
                    }
                    return;
                }
                characteristics[0].updateValue(value);
                // characteristics[1] is the unsupported low-battery state.
                this.updateUnavailable(characteristics[1]);
                return;
        }
    }

    private updateNumeric(characteristic: Characteristic, value: unknown, isInRange: (value: number) => boolean) {
        if (typeof value !== 'number' || !Number.isFinite(value) || !isInRange(value)) {
            this.updateUnavailable(characteristic);
            return;
        }
        characteristic.updateValue(value);
    }

    private updateUnavailable(characteristic: Characteristic) {
        characteristic.updateValue(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY));
    }
}
