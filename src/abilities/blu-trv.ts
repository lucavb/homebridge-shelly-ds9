import type { DynamicComponent, ShellyBluGatewayGen3 } from '@lucavb/shellies-ds9';
import { Categories, CharacteristicValue, type Characteristic, type WithUUID } from 'homebridge';

import { Ability, ServiceClass } from './base.ts';
import { parseBTHomeAddress } from '../utils/bthome.ts';

const MIN_TARGET_C = 4;
const MAX_TARGET_C = 30;

/**
 * The observed thermostat readings a TRV publishes, as characteristic names.
 * The platform marks the same characteristics unavailable for cached
 * accessories, so the list is shared instead of restated per call site.
 */
export const BLU_TRV_OBSERVED_CHARACTERISTICS = [
    'CurrentHeatingCoolingState',
    'CurrentTemperature',
    'TargetTemperature',
] as const;

/** Stable service identity for a verified BLE address, independent of gateway component ID. */
export function bluTrvServiceSubtype(address: string): string {
    if (parseBTHomeAddress(address) !== address) {
        throw new RangeError('BLU TRV service address must be normalized');
    }
    return `blu-trv-${address.replaceAll(':', '')}`;
}

/**
 * Exposes one paired BLU TRV as a heat-only HomeKit thermostat.
 *
 * HAP's CurrentHeatingCoolingState is represented explicitly as valve demand:
 * a valid `pos` of 0 means idle (HAP OFF), and a valid positive `pos` means
 * HEAT (the valve is open). This is not evidence that a boiler is running or
 * that heat is being delivered; boiler/hot-water availability is unknowable
 * from the BLU TRV status. Missing/invalid valve position is unavailable, not
 * OFF. Current and target temperatures are reported only from valid status.
 */
export class BluTrvAbility extends Ability {
    private writeQueue: Promise<void> = Promise.resolve();
    private detached = false;
    private lifecycleGeneration = 0;
    private awaitingFreshObservation = false;
    private disconnectBaseline: { lastUpdatedTs?: number; rsv?: number; packetId?: number } = {};
    private attached = false;
    private statusRefreshPending = false;
    private statusRefreshScheduled = false;
    private awaitingIdentitySnapshot = false;
    private pendingIdentityStatusUpdate?: Readonly<Record<string, unknown>>;

    /**
     * @param component - Actual runtime-discovered BLU TRV component/status.
     * @param gateway - Its BLU Gateway Gen3 host.
     * @param gatewayTrvId - Caller-parsed and validated component ID from the
     *   component key; DynamicComponent intentionally has no public `id`.
     */
    constructor(
        component: DynamicComponent,
        gateway: ShellyBluGatewayGen3,
        gatewayTrvId: number,
        readonly expectedAddress: string,
    ) {
        if (!Number.isSafeInteger(gatewayTrvId) || gatewayTrvId < 0) {
            throw new RangeError('BLU TRV gateway ID must be a non-negative safe integer');
        }
        if (parseBTHomeAddress(expectedAddress) !== expectedAddress) {
            throw new RangeError('BLU TRV expected address must be a normalized BLE address');
        }
        const componentId = parseBluTrvId(component.key);
        if (componentId !== gatewayTrvId) {
            throw new RangeError('BLU TRV gateway ID does not match the component key');
        }

        super(`BLU TRV ${gatewayTrvId}`, bluTrvServiceSubtype(expectedAddress));
        this.component = component;
        this.gateway = gateway;
        this.gatewayTrvId = gatewayTrvId;
    }

    component: DynamicComponent;

    gateway: ShellyBluGatewayGen3;

    gatewayTrvId: number;

    private readonly targetTemperatureHapGetHandler = (
        callback: (error: Error | null, value?: CharacteristicValue) => void,
    ) => this.targetTemperatureGetEventHandler(this.Characteristic.TargetTemperature, callback);
    private readonly currentTemperatureHapGetHandler = (
        callback: (error: Error | null, value?: CharacteristicValue) => void,
    ) => this.targetTemperatureGetEventHandler(this.Characteristic.CurrentTemperature, callback);
    private readonly currentStateHapGetHandler = (
        callback: (error: Error | null, value?: CharacteristicValue) => void,
    ) => this.targetTemperatureGetEventHandler(this.Characteristic.CurrentHeatingCoolingState, callback);

    get category(): Categories {
        return Categories.THERMOSTAT;
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.Thermostat;
    }

    protected initialize() {
        this.lifecycleGeneration++;
        this.detached = false;
        this.attached = true;
        this.resetDeferredStatusRefresh();
        // Component status can be inherited from Shelly.GetComponents or a
        // previously cached service. Trust only a post-setup TRV observation.
        this.requireFreshObservation();

        const currentTemperature = this.service.getCharacteristic(this.Characteristic.CurrentTemperature);
        // The BLU TRV measures ambient temperature; don't clamp or invent a
        // reading if the gateway reports a value outside HAP's default range.
        currentTemperature.setProps({ minValue: -50, maxValue: 100 });

        const targetTemperature = this.service.getCharacteristic(this.Characteristic.TargetTemperature);
        targetTemperature.setProps({ minValue: MIN_TARGET_C, maxValue: MAX_TARGET_C });
        targetTemperature.on('get', this.targetTemperatureHapGetHandler);
        this.service
            .getCharacteristic(this.Characteristic.CurrentTemperature)
            .on('get', this.currentTemperatureHapGetHandler);
        this.service
            .getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .on('get', this.currentStateHapGetHandler);

        const displayUnits = this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits);
        const celsius = this.Characteristic.TemperatureDisplayUnits.CELSIUS;
        displayUnits.setProps({ validValues: [celsius] }).updateValue(celsius);
        displayUnits.onSet(this.temperatureDisplayUnitsSetHandler.bind(this));

        // A TRV exposes one target setpoint, not separate heating/cooling
        // thresholds. Remove these optional HAP fields if a cached service
        // contains them.
        this.removeCharacteristic(this.Characteristic.HeatingThresholdTemperature);
        this.removeCharacteristic(this.Characteristic.CoolingThresholdTemperature);

        const targetMode = this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState);
        const heat = this.Characteristic.TargetHeatingCoolingState.HEAT;
        targetMode.setProps({ validValues: [heat] });
        targetMode.updateValue(heat);
        targetMode.onSet(this.targetHeatingCoolingStateSetHandler.bind(this));

        targetTemperature.on('set', this.targetTemperatureHapSetHandler);

        this.component
            .on('change:config', this.configChangeHandler, this)
            .on('change:pos', this.statusChangeHandler, this)
            .on('change:current_C', this.statusChangeHandler, this)
            .on('change:target_C', this.statusChangeHandler, this)
            .on('change:errors', this.statusChangeHandler, this)
            .on('change:paired', this.statusChangeHandler, this)
            .on('change:rsv', this.statusChangeHandler, this)
            .on('change:rsv', this.rsvChangeHandler, this)
            .on('change:last_updated_ts', this.lastUpdatedChangeHandler, this)
            .on('change:packet_id', this.packetIdChangeHandler, this);

        this.gateway.rpcHandler.on('disconnect', this.disconnectHandler).on('connect', this.connectHandler);

        this.refreshStatus();
    }

    detach() {
        if (!this.attached) {
            return;
        }
        const service = this.service;
        this.lifecycleGeneration++;
        this.detached = true;
        this.attached = false;
        this.resetDeferredStatusRefresh();
        this.component
            .off('change:config', this.configChangeHandler, this)
            .off('change:pos', this.statusChangeHandler, this)
            .off('change:current_C', this.statusChangeHandler, this)
            .off('change:target_C', this.statusChangeHandler, this)
            .off('change:errors', this.statusChangeHandler, this)
            .off('change:paired', this.statusChangeHandler, this)
            .off('change:rsv', this.statusChangeHandler, this)
            .off('change:rsv', this.rsvChangeHandler, this)
            .off('change:last_updated_ts', this.lastUpdatedChangeHandler, this)
            .off('change:packet_id', this.packetIdChangeHandler, this);
        this.gateway.rpcHandler.off('disconnect', this.disconnectHandler).off('connect', this.connectHandler);
        service
            .getCharacteristic(this.Characteristic.TargetTemperature)
            .off('get', this.targetTemperatureHapGetHandler)
            .off('set', this.targetTemperatureHapSetHandler);
        service
            .getCharacteristic(this.Characteristic.CurrentTemperature)
            .off('get', this.currentTemperatureHapGetHandler);
        service
            .getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .off('get', this.currentStateHapGetHandler);
    }

    /** Rebind an existing HomeKit service to a newly inventoried TRV at this address. */
    rebind(component: DynamicComponent, gateway: ShellyBluGatewayGen3, gatewayTrvId: number) {
        if (parseBluTrvId(component.key) !== gatewayTrvId) {
            throw new RangeError('BLU TRV gateway ID does not match the component key');
        }
        if (parseBTHomeAddress(component.config?.addr) !== this.expectedAddress) {
            throw new RangeError('BLU TRV component address does not match its service identity');
        }

        const wasAttached = this.attached;
        // The sole production caller passes the delegate's own gateway, so
        // the gateway never changes in practice; this branch is defensive.
        const gatewayChanged = this.gateway !== gateway;
        if (wasAttached) {
            this.component
                .off('change:config', this.configChangeHandler, this)
                .off('change:pos', this.statusChangeHandler, this)
                .off('change:current_C', this.statusChangeHandler, this)
                .off('change:target_C', this.statusChangeHandler, this)
                .off('change:errors', this.statusChangeHandler, this)
                .off('change:paired', this.statusChangeHandler, this)
                .off('change:rsv', this.statusChangeHandler, this)
                .off('change:rsv', this.rsvChangeHandler, this)
                .off('change:last_updated_ts', this.lastUpdatedChangeHandler, this)
                .off('change:packet_id', this.packetIdChangeHandler, this);
            if (gatewayChanged) {
                this.gateway.rpcHandler.off('disconnect', this.disconnectHandler).off('connect', this.connectHandler);
            }
        }

        this.lifecycleGeneration++;
        this.detached = !wasAttached;
        this.resetDeferredStatusRefresh();
        this.component = component;
        this.gateway = gateway;
        this.gatewayTrvId = gatewayTrvId;
        this.requireFreshObservation();

        if (wasAttached) {
            this.detached = false;
            this.component
                .on('change:config', this.configChangeHandler, this)
                .on('change:pos', this.statusChangeHandler, this)
                .on('change:current_C', this.statusChangeHandler, this)
                .on('change:target_C', this.statusChangeHandler, this)
                .on('change:errors', this.statusChangeHandler, this)
                .on('change:paired', this.statusChangeHandler, this)
                .on('change:rsv', this.statusChangeHandler, this)
                .on('change:rsv', this.rsvChangeHandler, this)
                .on('change:last_updated_ts', this.lastUpdatedChangeHandler, this)
                .on('change:packet_id', this.packetIdChangeHandler, this);
            if (gatewayChanged) {
                this.gateway.rpcHandler.on('disconnect', this.disconnectHandler).on('connect', this.connectHandler);
            }
            this.markStatusUnavailable();
        }
    }

    private readonly statusChangeHandler = () => this.refreshStatus();

    private readonly rsvChangeHandler = (value: unknown) => {
        this.noteFreshObservation('rsv', value);
        this.refreshStatus();
    };

    private readonly lastUpdatedChangeHandler = (value: unknown) => {
        this.noteFreshObservation('last_updated_ts', value);
        this.refreshStatus();
    };

    private readonly packetIdChangeHandler = (value: unknown) => {
        this.noteFreshObservation('packet_id', value);
        this.refreshStatus();
    };

    private readonly disconnectHandler = () => {
        this.lifecycleGeneration++;
        this.resetDeferredStatusRefresh();
        this.requireFreshObservation();
        this.markStatusUnavailable();
    };

    private readonly connectHandler = () => this.refreshStatus();
    private readonly targetTemperatureHapSetHandler = (
        value: CharacteristicValue,
        callback: (error?: Error | null) => void,
    ) => this.targetTemperatureSetEventHandler(value, callback);

    private targetTemperatureSetEventHandler(value: CharacteristicValue, callback: (error?: Error | null) => void) {
        const generation = this.lifecycleGeneration;
        const communicationError = new this.api.hap.HapStatusError(
            this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
        const respond = (error?: Error | null) => {
            try {
                callback(error);
            } catch (callbackError) {
                this.log.error(
                    'Failed to complete BLU TRV target characteristic write:',
                    callbackError instanceof Error ? callbackError.message : callbackError,
                );
            }
        };
        let write: Promise<void>;
        try {
            write = this.targetTemperatureSetHandler(value);
        } catch (error) {
            respond(error instanceof Error ? error : communicationError);
            return;
        }

        void write.then(
            () => {
                try {
                    // Legacy HAP set callbacks commit the characteristic
                    // synchronously when invoked. Revalidate at that exact
                    // completion boundary, not only after the RPC await.
                    this.assertWritable(generation, communicationError);
                    respond(null);
                } catch {
                    respond(communicationError);
                }
            },
            (error: unknown) => respond(error instanceof Error ? error : communicationError),
        );
    }

    private targetTemperatureGetEventHandler(
        characteristic: WithUUID<new () => Characteristic> & WithUUID<typeof Characteristic>,
        callback: (error: Error | null, value?: CharacteristicValue) => void,
    ) {
        const unavailable = new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY);
        if (
            this.detached ||
            this.statusRefreshPending ||
            this.awaitingFreshObservation ||
            this.awaitingIdentitySnapshot ||
            !this.gateway.rpcHandler.connected ||
            !this.isCurrentComponent()
        ) {
            callback(unavailable);
            return;
        }

        this.refreshStatus();
        const observed = this.service.getCharacteristic(characteristic);
        if (observed.statusCode !== this.api.hap.HAPStatus.SUCCESS || observed.value === null) {
            callback(unavailable);
            return;
        }
        // The legacy callback event commits synchronously in HAP. Unlike
        // onGet, it does not await a handler promise and then overwrite a
        // disconnect/rebind invalidation with stale success.
        callback(null, observed.value);
    }

    private targetHeatingCoolingStateSetHandler(value: CharacteristicValue) {
        if (this.detached) {
            throw new Error('BLU TRV ability is detached');
        }
        if (value !== this.Characteristic.TargetHeatingCoolingState.HEAT) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
    }

    private temperatureDisplayUnitsSetHandler(value: CharacteristicValue) {
        if (this.detached) {
            throw new Error('BLU TRV ability is detached');
        }
        if (value !== this.Characteristic.TemperatureDisplayUnits.CELSIUS) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
    }

    private targetTemperatureSetHandler(value: CharacteristicValue): Promise<void> {
        if (this.detached) {
            return Promise.reject(new Error('BLU TRV ability is detached'));
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_TARGET_C || value > MAX_TARGET_C) {
            return Promise.reject(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST));
        }

        const targetC = value;
        const generation = this.lifecycleGeneration;
        const communicationError = new this.api.hap.HapStatusError(
            this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
        const write = this.writeQueue
            .catch(() => undefined)
            .then(async () => {
                this.assertWritable(generation, communicationError);
                // Keep the RPC exact: the gateway receives its TRV component
                // ID, with the TRV's single internal thermostat id.
                await this.gateway.callTrv(this.gatewayTrvId, 'TRV.SetTarget', {
                    id: 0,
                    target_C: targetC,
                });
                // HAP writes the requested value after this handler resolves.
                // A disconnect/rebind while RPC is pending invalidates that
                // success so HAP cannot cache a value for the old binding.
                this.assertWritable(generation, communicationError);
            });

        // A failed write must not poison the queue; each caller still receives
        // its own rejection and later queued requests are checked afresh.
        this.writeQueue = write.catch(() => undefined);

        return write.catch((error: unknown) => {
            if (!this.isCurrentGeneration(generation)) {
                throw communicationError;
            }
            this.log.error('Failed to set BLU TRV target temperature:', error instanceof Error ? error.message : error);
            throw communicationError;
        });
    }

    private assertWritable(generation: number, communicationError: Error) {
        if (!this.isCurrentGeneration(generation)) {
            throw communicationError;
        }
        if (!this.isCurrentComponent()) {
            if (!this.awaitingIdentitySnapshot) {
                this.requireFreshObservation();
            }
            this.markStatusUnavailable();
            throw communicationError;
        }
        const status = this.component.status;
        if (
            !this.gateway.rpcHandler.connected ||
            this.awaitingFreshObservation ||
            this.awaitingIdentitySnapshot ||
            status.paired !== true ||
            !this.hasValidStateVersion(status) ||
            !this.isValidPosition(status.pos) ||
            this.hasReportedFault(status)
        ) {
            throw communicationError;
        }
    }

    private refreshStatus() {
        if (this.detached) {
            return;
        }
        if (this.component.updateDepth > 0) {
            this.deferStatusRefresh();
            return;
        }
        if (!this.isCurrentComponent()) {
            if (!this.awaitingIdentitySnapshot) {
                this.requireFreshObservation();
            }
            this.markStatusUnavailable();
            return;
        }
        if (
            !this.gateway.rpcHandler.connected ||
            this.awaitingFreshObservation ||
            this.awaitingIdentitySnapshot ||
            !this.isPaired(this.component.status)
        ) {
            this.markStatusUnavailable();
            return;
        }

        const status = this.component.status;
        // The error meanings are not verified here. Do not claim valve demand
        // while any gateway-reported fault is active; temperature remains
        // independently useful and is still reported below.
        if (this.isValidPosition(status.pos) && !this.hasReportedFault(status)) {
            const currentState =
                status.pos === 0
                    ? this.Characteristic.CurrentHeatingCoolingState.OFF
                    : this.Characteristic.CurrentHeatingCoolingState.HEAT;
            this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState).updateValue(currentState);
        } else {
            this.markUnavailable(this.Characteristic.CurrentHeatingCoolingState);
        }

        if (this.isCurrentTemperature(status.current_C)) {
            this.service.getCharacteristic(this.Characteristic.CurrentTemperature).updateValue(status.current_C);
        } else {
            this.markUnavailable(this.Characteristic.CurrentTemperature);
        }

        if (this.isTargetTemperature(status.target_C)) {
            this.service.getCharacteristic(this.Characteristic.TargetTemperature).updateValue(status.target_C);
        } else {
            this.markUnavailable(this.Characteristic.TargetTemperature);
        }

        // Target mode is intentionally heat-only and independent of the
        // observed valve demand. Boiler/hot-water operation is not observable.
        this.service
            .getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .updateValue(this.Characteristic.TargetHeatingCoolingState.HEAT);
    }

    private deferStatusRefresh() {
        this.statusRefreshPending = true;
        this.markStatusUnavailable();
        const pendingUpdate = this.component.pendingUpdate;
        if (pendingUpdate) {
            this.pendingIdentityStatusUpdate = pendingUpdate;
        }
        if (this.statusRefreshScheduled) {
            return;
        }
        this.statusRefreshScheduled = true;
        const generation = this.lifecycleGeneration;
        const component = this.component;
        queueMicrotask(() => {
            // A queued update belongs only to the lifecycle and component that
            // scheduled it. Lifecycle transitions reset their own flags; an
            // old callback must not clear those flags or publish on a new bind.
            if (generation !== this.lifecycleGeneration || component !== this.component || this.detached) {
                return;
            }
            this.statusRefreshScheduled = false;
            this.statusRefreshPending = false;
            const statusUpdate = this.pendingIdentityStatusUpdate;
            this.pendingIdentityStatusUpdate = undefined;
            if (
                this.awaitingIdentitySnapshot &&
                statusUpdate !== undefined &&
                this.isCurrentComponent() &&
                this.isCompleteFreshIdentityStatus(statusUpdate)
            ) {
                this.awaitingIdentitySnapshot = false;
                this.awaitingFreshObservation = false;
            }
            this.refreshStatus();
        });
    }

    private resetDeferredStatusRefresh() {
        this.statusRefreshPending = false;
        this.statusRefreshScheduled = false;
        this.pendingIdentityStatusUpdate = undefined;
    }

    private readonly configChangeHandler = (
        current: Record<string, unknown> | undefined,
        previous: Record<string, unknown> | undefined,
        statusUpdate: Readonly<Record<string, unknown>> | undefined,
    ) => {
        if (!this.attached || this.detached) {
            return;
        }
        const previousAddress = parseBTHomeAddress(previous?.addr);
        const currentAddress = parseBTHomeAddress(current?.addr);
        if (
            previousAddress === currentAddress &&
            currentAddress === this.expectedAddress &&
            !this.awaitingIdentitySnapshot
        ) {
            return;
        }

        this.lifecycleGeneration++;
        this.resetDeferredStatusRefresh();
        if (!this.awaitingIdentitySnapshot) {
            this.requireFreshObservation();
        }
        this.awaitingIdentitySnapshot = true;
        if (
            currentAddress === this.expectedAddress &&
            statusUpdate !== undefined &&
            this.isCompleteFreshIdentityStatus(statusUpdate)
        ) {
            // Only a complete snapshot with changed version evidence can
            // restore an identity after a retained component was assigned to
            // another peripheral. Empty/partial payloads must not validate a
            // mixture of old and new status fields.
            this.awaitingIdentitySnapshot = false;
            this.awaitingFreshObservation = false;
        }
        this.markStatusUnavailable();
        if (!this.awaitingIdentitySnapshot) {
            this.refreshStatus();
        }
    };

    private isCompleteFreshIdentityStatus(status: Readonly<Record<string, unknown>>): boolean {
        if (
            !Object.prototype.hasOwnProperty.call(status, 'current_C') ||
            !Object.prototype.hasOwnProperty.call(status, 'target_C') ||
            !Object.prototype.hasOwnProperty.call(status, 'pos') ||
            !Object.prototype.hasOwnProperty.call(status, 'paired') ||
            status.paired !== true ||
            !this.isCurrentTemperature(status.current_C) ||
            !this.isTargetTemperature(status.target_C) ||
            !this.isValidPosition(status.pos)
        ) {
            return false;
        }

        const newerTimestamp =
            typeof status.last_updated_ts === 'number' &&
            Number.isFinite(status.last_updated_ts) &&
            status.last_updated_ts >= 0 &&
            (this.disconnectBaseline.lastUpdatedTs === undefined ||
                status.last_updated_ts > this.disconnectBaseline.lastUpdatedTs);
        const newerStateVersion =
            typeof status.rsv === 'number' &&
            Number.isFinite(status.rsv) &&
            status.rsv >= 0 &&
            (this.disconnectBaseline.rsv === undefined || status.rsv !== this.disconnectBaseline.rsv);
        const newerPacket =
            typeof status.packet_id === 'number' &&
            Number.isFinite(status.packet_id) &&
            status.packet_id >= 0 &&
            (this.disconnectBaseline.packetId === undefined || status.packet_id !== this.disconnectBaseline.packetId);

        return newerTimestamp || newerStateVersion || newerPacket;
    }

    private markStatusUnavailable() {
        for (const characteristicName of BLU_TRV_OBSERVED_CHARACTERISTICS) {
            this.markUnavailable(this.Characteristic[characteristicName]);
        }
        // A fixed supported target mode is a capability, not an observed
        // status; retain HEAT as the only supported target mode.
        this.service
            .getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .updateValue(this.Characteristic.TargetHeatingCoolingState.HEAT);
    }

    private requireFreshObservation() {
        const status = this.component.status;
        this.disconnectBaseline = {
            lastUpdatedTs: this.numericStatus(status.last_updated_ts),
            rsv: this.numericStatus(status.rsv),
            packetId: this.numericStatus(status.packet_id),
        };
        this.awaitingFreshObservation = true;
    }

    private noteFreshObservation(field: 'last_updated_ts' | 'rsv' | 'packet_id', value: unknown) {
        if (!this.awaitingFreshObservation || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            return;
        }

        if (field === 'last_updated_ts') {
            const baseline = this.disconnectBaseline.lastUpdatedTs;
            if (baseline === undefined || value > baseline) {
                this.awaitingFreshObservation = false;
            }
            return;
        }

        const baseline = field === 'rsv' ? this.disconnectBaseline.rsv : this.disconnectBaseline.packetId;
        // rsv is a state-version counter and packet_id identifies a received
        // packet. A changed valid value after disconnect is evidence newer than
        // the cached status; unchanged cached values are not.
        if (baseline === undefined || value !== baseline) {
            this.awaitingFreshObservation = false;
        }
    }

    private numericStatus(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    private isCurrentGeneration(generation: number): boolean {
        return !this.detached && generation === this.lifecycleGeneration;
    }

    private isCurrentComponent(): boolean {
        try {
            return (
                this.gateway.getComponent(this.component.key) === this.component &&
                parseBluTrvId(this.component.key) === this.gatewayTrvId &&
                parseBTHomeAddress(this.component.config?.addr) === this.expectedAddress
            );
        } catch {
            return false;
        }
    }

    private markUnavailable(characteristic: WithUUID<new () => Characteristic> & WithUUID<typeof Characteristic>) {
        this.service
            .getCharacteristic(characteristic)
            .updateValue(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY));
    }

    private isPaired(status: Readonly<Record<string, unknown>>): boolean {
        return status.paired === true && this.hasValidStateVersion(status);
    }

    private hasValidStateVersion(status: Readonly<Record<string, unknown>>): boolean {
        const rsv = status.rsv;
        // rsv is -1 when the TRV has not supplied remote state. Older/partial
        // status payloads may omit it, in which case `paired` and the fields
        // themselves remain the available evidence.
        return rsv === undefined || (typeof rsv === 'number' && Number.isFinite(rsv) && rsv >= 0);
    }

    private isValidPosition(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
    }

    private isTemperature(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value);
    }

    private isCurrentTemperature(value: unknown): value is number {
        // Match the published HAP property range so hap-nodejs cannot silently
        // clamp an upstream outlier into a false reading.
        return this.isTemperature(value) && value >= -50 && value <= 100;
    }

    private isTargetTemperature(value: unknown): value is number {
        return this.isTemperature(value) && value >= MIN_TARGET_C && value <= MAX_TARGET_C;
    }

    private hasReportedFault(status: Readonly<Record<string, unknown>>): boolean {
        const errors = status.errors;
        if (errors === undefined || errors === null) {
            return false;
        }
        if (Array.isArray(errors)) {
            return errors.length > 0;
        }
        return typeof errors === 'string' ? errors.length > 0 : true;
    }
}

/** Parses the numeric TRV id from a `blutrv:<id>` component key. */
export function parseBluTrvId(key: string): number | undefined {
    const match = /^blutrv:(\d+)$/i.exec(key);
    if (!match) {
        return undefined;
    }
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}
