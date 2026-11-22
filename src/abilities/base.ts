import { API, Characteristic, PlatformAccessory, Service, WithUUID, Categories } from 'homebridge';

import { CustomCharacteristics } from '../utils/characteristics.ts';
import { CustomServices } from '../utils/services.ts';
import { DeviceLogger } from '../utils/device-logger.ts';
import { ShellyPlatform } from '../platform.ts';
import type { HistoryKind, WeatherHistoryRecorder } from '../history.ts';

export type ServiceClass = WithUUID<typeof Service>;

/**
 * Base class for all abilities.
 * An ability is roughly equivalent to a HomeKit service.
 */
export abstract class Ability {
    private homebridgeAccessory: PlatformAccessory | null = null;

    /**
     * The associated platform accessory.
     */
    get platformAccessory(): PlatformAccessory {
        if (this.homebridgeAccessory === null) {
            throw new Error('Ability has not yet been setup');
        }
        return this.homebridgeAccessory;
    }

    private shellyPlatform: ShellyPlatform | null = null;

    /**
     * A reference to the platform.
     */
    protected get platform(): ShellyPlatform {
        if (this.shellyPlatform === null) {
            throw new Error('Ability has not yet been setup');
        }
        return this.shellyPlatform;
    }

    /**
     * A reference to the homebridge API.
     */
    protected get api(): API {
        return this.platform.api;
    }

    /**
     * Shorthand property.
     */
    protected get Characteristic(): typeof Characteristic {
        return this.platform.api.hap.Characteristic;
    }

    /**
     * Shorthand property.
     */
    protected get Service(): typeof Service {
        return this.platform.api.hap.Service;
    }

    /**
     * Shorthand property.
     */
    protected get customCharacteristics(): CustomCharacteristics {
        return this.platform.customCharacteristics;
    }

    /**
     * Shorthand property.
     */
    protected get customServices(): CustomServices {
        return this.platform.customServices;
    }

    private logger: DeviceLogger | null = null;

    /**
     * The logging device to use.
     */
    protected get log(): DeviceLogger {
        if (this.logger === null) {
            throw new Error('Ability has not yet been setup');
        }
        return this.logger;
    }

    private hapService: Service | null = null;

    /**
     * The HomeKit service that this ability uses.
     */
    protected get service(): Service {
        if (this.hapService === null) {
            throw new Error('Ability has not yet been setup');
        }
        return this.hapService;
    }

    private activeState = true;

    /**
     * Whether this ability is active.
     * Setting an ability to inactive will remove its HomeKit service.
     */
    get active(): boolean {
        return this.activeState;
    }

    set active(value) {
        if (value === this.activeState) {
            return;
        }

        this.activeState = value;
        this.update();
    }

    /**
     * @param serviceName - A name of the service.
     * @param serviceSubtype - A unique identifier for the service.
     */
    constructor(
        protected readonly serviceName?: string,
        public readonly serviceSubtype?: string,
    ) {}

    /**
     * Sets up this ability.
     * This method is called by the parent accessory every time it becomes active.
     * @param platformAccessory - The homebridge platform accessory to use.
     * @param platform - A reference to the platform.
     * @param log - The logger to use.
     */
    setup(platformAccessory: PlatformAccessory, platform: ShellyPlatform, log: DeviceLogger) {
        this.homebridgeAccessory = platformAccessory;
        this.shellyPlatform = platform;
        this.logger = log;

        this.update();
    }

    /**
     * Sets `active` to the given value.
     * This method can be used when chaining calls, as it returns a reference to `this`.
     * @param value - Whether the ability should be active.
     */
    setActive(value: boolean): this {
        this.active = value;
        return this;
    }

    /**
     * The weather history recorder that this ability feeds its readings to, if any.
     * The parent accessory attaches it via `setRecorder()` before it sets up its
     * abilities, on every activate cycle. `destroy()` clears it; `Accessory.detach()`
     * leaves it attached, which is safe because a detached recorder ignores readings.
     */
    private recorder: WeatherHistoryRecorder | null = null;

    /**
     * Attaches the weather history recorder for this ability.
     * Called by the parent accessory on every activate cycle, before the
     * abilities are set up, so that the abilities' setup-time seedings of
     * their characteristics are recorded as well.
     * @param recorder - The recorder to attach.
     */
    public setRecorder(recorder: WeatherHistoryRecorder): void {
        this.recorder = recorder;
    }

    /**
     * Records a sensor reading, if a weather history recorder is attached.
     * No-op otherwise.
     * @param kind - The kind of the reading.
     * @param value - The reading, in degrees Celsius or percent relative humidity.
     */
    protected record(kind: HistoryKind, value: number): void {
        if (this.recorder === null) {
            return;
        }

        this.recorder.record(kind, value);
    }

    /**
     * The kind of readings that this ability records, if it records any.
     * Returns `undefined` when this ability does not record history.
     */
    get historyKind(): HistoryKind | undefined {
        return undefined;
    }

    /**
     * The HomeKit category that this ability maps to, if it determines its
     * accessory's category. This getter re-creates the semantics of the old
     * `resolveAccessoryCategory()` chain: the parent accessory uses the first
     * ability, in a fixed order, that returns a category, and falls back to
     * `Categories.OTHER` if none does.
     */
    get category(): Categories | undefined {
        return undefined;
    }

    /**
     * Determines whether this ability is active.
     * The default implementation simply returns the value of the `active` property.
     * Subclasses can override this method to add more conditions.
     */
    protected isActive(): boolean {
        return this.active;
    }

    /**
     * Updates this ability based on whether it is active.
     * If active, its service will be added and initialized.
     * If inactive, its service will be removed.
     */
    protected update() {
        if (this.homebridgeAccessory === null) {
            // abort if setup() hasn't been called yet
            return;
        }

        if (this.isActive()) {
            // we're active, add and initialize our service
            if (this.hapService === null) {
                this.hapService = this.addService();
                this.initialize();
            }
        } else {
            // we're inactive, detach from and remove our service
            if (this.hapService !== null) {
                this.detach();
            }

            this.removeService();
            this.hapService = null;
        }
    }

    /**
     * Returns a service for this ability.
     * If the platform accessory has a matching service, it will be returned. Otherwise, the service will be added.
     */
    protected addService(): Service | null {
        let service: Service | undefined;
        if (this.serviceName && this.serviceSubtype) {
            service =
                this.platformAccessory.getServiceById(this.serviceClass, this.serviceSubtype) ||
                this.platformAccessory.addService(this.serviceClass, this.serviceName, this.serviceSubtype);
        } else {
            service =
                this.platformAccessory.getService(this.serviceClass) ||
                this.platformAccessory.addService(this.serviceClass, '', '');
        }
        return service ?? null;
    }

    /**
     * Removes this ability's service from the platform accessory.
     */
    protected removeService() {
        let service: Service | undefined;

        // since the platform accessory may have been loaded from cache with a service created previously,
        // we can't just rely on hapService here
        if (this.hapService !== null) {
            service = this.hapService;
        } else if (this.serviceName && this.serviceSubtype) {
            service = this.platformAccessory.getServiceById(this.serviceClass, this.serviceSubtype);
        } else {
            service = this.platformAccessory.getService(this.serviceClass);
        }

        if (service) {
            this.platformAccessory.removeService(service);
        }
    }

    /**
     * Helper method that removes a characteristic based on its class (Service.removeCharacteristic()
     * only accepts an instance).
     * @param characteristic - The characteristic to remove.
     */
    protected removeCharacteristic(
        characteristic: WithUUID<new () => Characteristic> & WithUUID<typeof Characteristic>,
    ) {
        const s = this.service;

        // getCharacteristic() will add the characteristic if it doesn't exist, so we need to use testCharacteristic() to avoid
        // adding and then immediately removing it
        if (s.testCharacteristic(characteristic)) {
            s.removeCharacteristic(s.getCharacteristic(characteristic));
        }
    }

    /**
     * Subclasses should implement this method to return the HomeKit service type to use.
     */
    protected abstract get serviceClass(): ServiceClass;

    /**
     * Subclasses should use this method to initialize the service and attach their event listeners.
     */
    protected abstract initialize();

    /**
     * Subclasses should use this method to remove their event listeners.
     */
    abstract detach();

    /**
     * Removes all event listeners and all references to the platform accessory.
     * This method is called by the parent accessory every time it becomes inactive.
     * Note that this method doesn't remove the service from the platform accessory as it is assumed that
     * the entire platform accessory is about to be unregistered and discarded.
     */
    destroy() {
        this.detach();

        this.homebridgeAccessory = null;
        this.shellyPlatform = null;
        this.logger = null;
        this.hapService = null;
        this.recorder = null;
    }
}
