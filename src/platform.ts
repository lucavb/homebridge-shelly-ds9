import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import {
    Device,
    DeviceDiscoverer,
    DeviceId,
    DeviceIdentifiers,
    MdnsDeviceDiscoverer,
    Shellies,
} from '@lucavb/shellies-ds9';

import { CustomCharacteristics, createCharacteristics } from './utils/characteristics.ts';
import { CustomServices, createServices } from './utils/services.ts';
import { DeviceCache } from './utils/device-cache.ts';
import { resolveStoragePath } from './utils/storage-path.ts';
import { bthomeSensorKindDescriptors, parseBTHomeSensorKind } from './utils/bthome.ts';
import { DeviceDelegate } from './device-delegates/index.ts';
import { BTHomeHostDelegate, ShellyBluGatewayDelegate } from './device-delegates/shelly-blu-gateway.ts';
import { PlatformOptions } from './config.ts';

type AccessoryUuid = string;

/**
 * The name of this plugin.
 */
export const PLUGIN_NAME = '@lucavb/homebridge-shelly-ds9';

/**
 * The name of this homebridge platform.
 */
export const PLATFORM_NAME = 'ShellyDS9';

/**
 * Utility class that "discovers" devices from the configuration options.
 */
export class ConfigDeviceDiscoverer extends DeviceDiscoverer {
    /**
     * @param options - The platform configuration options.
     * @param emitInterval - The interval, in milliseconds, to wait between each emitted device.
     */
    constructor(
        readonly options: PlatformOptions,
        readonly emitInterval = 20,
    ) {
        super();
    }

    /**
     * Runs this discoverer.
     */
    async run() {
        // emit all devices that have a configured hostname
        for (const [id, opts] of this.options.deviceOptions) {
            if (opts.hostname) {
                await this.emitDevice({
                    deviceId: id,
                    hostname: opts.hostname,
                });
            }
        }
    }

    /**
     * Emits a device after the configured time interval has passed.
     */
    protected emitDevice(identifiers: DeviceIdentifiers): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(() => {
                super.handleDiscoveredDevice(identifiers);
                resolve();
            }, this.emitInterval);
        });
    }
}

/**
 * Utility class that "discovers" devices from a cache.
 */
export class CacheDeviceDiscoverer extends DeviceDiscoverer {
    /**
     * @param deviceCache - The cached devices.
     * @param emitInterval - The interval, in milliseconds, to wait between each emitted device.
     */
    constructor(
        readonly deviceCache: DeviceCache,
        readonly emitInterval = 20,
    ) {
        super();
    }

    /**
     * Runs this discoverer.
     */
    async run() {
        // emit all cached devices
        for (const d of this.deviceCache) {
            await this.emitDevice({
                deviceId: d.id,
                hostname: d.hostname,
            });
        }
    }

    /**
     * Emits a device after the configured time interval has passed.
     */
    protected emitDevice(identifiers: DeviceIdentifiers): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(() => {
                super.handleDiscoveredDevice(identifiers);
                resolve();
            }, this.emitInterval);
        });
    }
}

/**
 * Implements a homebridge dynamic platform plugin.
 */
export class ShellyPlatform implements DynamicPlatformPlugin {
    /**
     * The configuration options for this platform.
     */
    readonly options: PlatformOptions;

    /**
     * A set of custom HomeKit characteristics.
     */
    readonly customCharacteristics: CustomCharacteristics;

    /**
     * A set of custom HomeKit services.
     */
    readonly customServices: CustomServices;

    /**
     * A reference to the shellies-ds9 library.
     */
    protected readonly shellies: Shellies;

    /**
     * Holds all platform accessories that were loaded from cache during launch,
     * as well as accessories that have been created since launch.
     */
    protected readonly accessories: Map<AccessoryUuid, PlatformAccessory> = new Map();

    /**
     * A reference to our cached devices.
     */
    readonly deviceCache: DeviceCache;

    /**
     * Holds all device delegates.
     */
    readonly deviceDelegates: Map<DeviceId, DeviceDelegate> = new Map();

    /** Hosted BTHome manager delegates attached alongside normal device delegates. */
    readonly bthomeDelegates: Map<DeviceId, BTHomeHostDelegate> = new Map();

    /** Prevents the same physical BLE peripheral from being exposed by multiple hosts. */
    readonly bthomePeripheralOwners = new Map<string, DeviceId>();

    private readonly discoverers = new Set<DeviceDiscoverer>();

    private mdnsDiscoverer: MdnsDeviceDiscoverer | undefined;

    private shuttingDown = false;

    /**
     * This constructor is invoked by homebridge.
     * @param log - A logging device for this platform.
     * @param config - Configuration options for this platform.
     * @param api - A reference to the homebridge API.
     */
    constructor(
        readonly log: Logger,
        config: PlatformConfig,
        readonly api: API,
    ) {
        // get the platform options
        this.options = new PlatformOptions(config);

        this.customCharacteristics = Object.freeze(createCharacteristics(api));
        this.customServices = Object.freeze(createServices(api, this.customCharacteristics));

        // setup shellies-ds9
        this.shellies = new Shellies({
            websocket: {
                ...this.options.websocket,
                clientId: 'homebridge-shelly-ds9-' + Math.round(Math.random() * 1000000),
            },
            autoLoadStatus: true,
            autoLoadConfig: true,
            deviceOptions: this.options.deviceOptions,
        });
        // Keep the add listener: discovery already in flight may still emit a
        // device after shutdown. Its shutdown guard closes the late RPC handler
        // without creating delegates/accessories.
        this.shellies
            .on('add', this.handleAddedDevice, this)
            .on('remove', this.handleRemovedDevice, this)
            .on('exclude', this.handleExcludedDevice, this)
            .on('unknown', this.handleUnknownDevice, this)
            .on('error', this.handleError, this);

        const storagePath = resolveStoragePath(api) ?? '.';
        this.deviceCache = new DeviceCache(storagePath, log);

        // wait for homebridge to finish launching
        api.on('didFinishLaunching', this.initialize.bind(this));
        // Detach listeners/timers only. Homebridge already persisted accessories;
        // ordinary shutdown must not unregister their stable identities.
        api.on('shutdown', this.detach.bind(this));
    }

    /**
     * Configures cached accessories.
     * This method is invoked once for each cached accessory that is loaded during launch.
     */
    configureAccessory(accessory: PlatformAccessory) {
        // store it for later
        this.accessories.set(accessory.UUID, accessory);
    }

    /**
     * Returns the platform accessory with the given UUID.
     * @param uuid - The UUID.
     */
    getAccessory(uuid: AccessoryUuid): PlatformAccessory | undefined {
        return this.accessories.get(uuid);
    }

    /** Returns cached BTHome accessories, optionally restricted to their Shelly host. */
    getBTHomeAccessories(deviceId?: DeviceId): PlatformAccessory[] {
        return Array.from(this.accessories.values()).filter((accessory) => {
            const device = accessory.context.device as { id?: unknown; bthomeAddress?: unknown } | undefined;
            return typeof device?.bthomeAddress === 'string' && (deviceId === undefined || device.id === deviceId);
        });
    }

    /** Marks cached sensor characteristics unavailable before the host reconnects. */
    markBTHomeAccessoriesUnavailable(deviceId?: DeviceId) {
        const error = new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY);
        for (const accessory of this.getBTHomeAccessories(deviceId)) {
            const device = accessory.context.device as Record<string, unknown>;
            const unavailable = (device.bthomeUnavailableServices as Record<string, unknown> | undefined) ?? {};
            for (const service of [...accessory.services]) {
                const subtype = service.subtype;
                if (!subtype?.startsWith('bthome-')) {
                    continue;
                }
                // Button services (`bthome-button-*`) and unknown kinds have no
                // readable value to invalidate. The kind → characteristic mapping
                // comes from the shared BTHome descriptor table, so every
                // registered sensor kind is covered here.
                const kind = parseBTHomeSensorKind(subtype);
                if (kind === undefined) {
                    continue;
                }
                for (const name of bthomeSensorKindDescriptors[kind].characteristics) {
                    service.getCharacteristic(this.api.hap.Characteristic[name]).updateValue(error);
                }
                unavailable[subtype] = true;
            }
            device.bthomeUnavailableServices = unavailable;
        }
    }

    /** Detaches every delegate without unregistering persistent accessories. */
    protected detach() {
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;

        for (const discoverer of this.discoverers) {
            this.shellies.unregisterDiscoverer(discoverer);
        }
        this.discoverers.clear();

        if (this.mdnsDiscoverer) {
            void this.mdnsDiscoverer.stop().catch((error: unknown) => {
                this.log.debug(
                    'Failed to stop mDNS discovery during shutdown:',
                    error instanceof Error ? error.message : error,
                );
            });
            this.mdnsDiscoverer = undefined;
        }

        this.shellies
            .off('remove', this.handleRemovedDevice, this)
            .off('exclude', this.handleExcludedDevice, this)
            .off('unknown', this.handleUnknownDevice, this)
            .off('error', this.handleError, this);

        for (const delegate of this.deviceDelegates.values()) {
            delegate.detach();
        }
        for (const delegate of this.bthomeDelegates.values()) {
            delegate.detach();
        }

        // These WebSocket handlers belong to this platform. Closing them is
        // non-destructive: delegates are detached first and cached accessories
        // remain registered for Homebridge to persist.
        for (const device of this.shellies.values()) {
            this.closeDeviceHandler(device);
        }
    }

    private closeDeviceHandler(device: Device) {
        try {
            void Promise.resolve(device.rpcHandler.destroy()).catch((error: unknown) => {
                this.log.debug(
                    'Failed to close a Shelly connection during shutdown:',
                    error instanceof Error ? error.message : error,
                );
            });
        } catch (error) {
            this.log.debug(
                'Failed to close a Shelly connection during shutdown:',
                error instanceof Error ? error.message : error,
            );
        }
    }

    /** Claims a normalized physical BTHome address for its current RPC host. */
    claimBTHomePeripheral(address: string, deviceId: DeviceId): boolean {
        const owner = this.bthomePeripheralOwners.get(address);
        if (owner !== undefined && owner !== deviceId) {
            return false;
        }
        this.bthomePeripheralOwners.set(address, deviceId);
        return true;
    }

    /** Releases a BTHome address only when the caller still owns it. */
    releaseBTHomePeripheral(address: string, deviceId: DeviceId) {
        if (this.bthomePeripheralOwners.get(address) === deviceId) {
            this.bthomePeripheralOwners.delete(address);
        }
    }

    /**
     * Adds one or more platform accessories to this platform.
     * This method will also register the accessories with homebridge.
     * @param accessories - The platform accessories to add.
     */
    addAccessory(...accessories: PlatformAccessory[]) {
        if (accessories.length === 0) {
            return;
        }

        const accs: PlatformAccessory[] = [];

        // add the accessories to our list
        for (const pa of accessories) {
            // skip if this accessory has already been added
            if (this.accessories.has(pa.UUID)) {
                continue;
            }

            this.accessories.set(pa.UUID, pa);
            accs.push(pa);
        }

        // register the accessories with homebridge
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accs);
    }

    /**
     * Removes one or more platform accessories from this platform.
     * This method will also unregister the accessories from homebridge.
     * @param accessories - The platform accessories to remove.
     */
    removeAccessory(...accessories: PlatformAccessory[]) {
        if (accessories.length === 0) {
            return;
        }

        // remove the accessories from our list
        for (const pa of accessories) {
            this.accessories.delete(pa.UUID);
        }

        // unregister the accessories from homebridge
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    }

    /**
     * Initializes this platform.
     */
    protected async initialize() {
        if (this.shuttingDown) {
            return;
        }
        this.log.debug(
            this.accessories.size === 1
                ? 'Loaded 1 accessory from cache'
                : `Loaded ${this.accessories.size} accessories from cache`,
        );

        if (!this.options.bthome.enable) {
            this.removeAccessory(...this.getBTHomeAccessories());
        } else {
            this.markBTHomeAccessoriesUnavailable();
        }

        await this.runConfigDeviceDiscoverer();
        if (this.shuttingDown) {
            return;
        }

        // load cached devices
        try {
            await this.deviceCache.load();
        } catch (e) {
            this.log.error('Failed to load cached devices:', e instanceof Error ? e.message : e);
        }
        if (this.shuttingDown) {
            return;
        }

        await this.runCacheDeviceDiscoverer();
        if (this.shuttingDown) {
            return;
        }

        if (this.options.mdns.enable === true) {
            this.startMdnsDeviceDiscovery();
        } else {
            this.log.debug('mDNS device discovery disabled');
        }
    }

    /**
     * Discovers all devices found in the configuration.
     */
    protected runConfigDeviceDiscoverer(): Promise<void> {
        if (this.shuttingDown) {
            return Promise.resolve();
        }
        // create a device discoverer
        const discoverer = new ConfigDeviceDiscoverer(this.options);
        if (!this.registerDiscoverer(discoverer)) {
            return Promise.resolve();
        }
        return discoverer.run().finally(() => this.unregisterDiscoverer(discoverer));
    }

    /**
     * Discovers all devices found in cache.
     */
    protected runCacheDeviceDiscoverer(): Promise<void> {
        if (this.shuttingDown) {
            return Promise.resolve();
        }
        // create a device discoverer
        const discoverer = new CacheDeviceDiscoverer(this.deviceCache);
        if (!this.registerDiscoverer(discoverer)) {
            return Promise.resolve();
        }
        return discoverer.run().finally(() => this.unregisterDiscoverer(discoverer));
    }

    private registerDiscoverer(discoverer: DeviceDiscoverer): boolean {
        if (this.shuttingDown) {
            return false;
        }
        this.discoverers.add(discoverer);
        this.shellies.registerDiscoverer(discoverer);
        return true;
    }

    private unregisterDiscoverer(discoverer: DeviceDiscoverer) {
        if (this.discoverers.delete(discoverer)) {
            this.shellies.unregisterDiscoverer(discoverer);
        }
    }

    /**
     * Starts device discovery over mDNS.
     */
    protected async startMdnsDeviceDiscovery() {
        if (this.shuttingDown) {
            return;
        }
        // create a device discoverer
        const discoverer = new MdnsDeviceDiscoverer(this.options.mdns);
        if (!this.registerDiscoverer(discoverer)) {
            return;
        }
        this.mdnsDiscoverer = discoverer;

        // log errors
        discoverer.on('error', (error: Error) => {
            this.log.error('An error occurred in the mDNS device discovery service:', error.message);
            this.log.debug(error.stack || '');
        });

        try {
            // start the service
            await discoverer.start();

            if (this.shuttingDown) {
                await discoverer.stop();
                this.unregisterDiscoverer(discoverer);
                return;
            }

            this.log.info('mDNS device discovery started');
        } catch (e) {
            this.log.error('Failed to start the mDNS device discovery service:', e instanceof Error ? e.message : e);
            if (e instanceof Error && e.stack) {
                this.log.debug(e.stack);
            }
            this.unregisterDiscoverer(discoverer);
            if (this.mdnsDiscoverer === discoverer) {
                this.mdnsDiscoverer = undefined;
            }
        }
    }

    /**
     * Handles 'add' events from the shellies-ds9 library.
     */
    protected async handleAddedDevice(device: Device) {
        if (this.shuttingDown) {
            this.closeDeviceHandler(device);
            return;
        }
        // make sure this device hasn't already been added
        if (this.deviceDelegates.has(device.id)) {
            this.log.error(`Device with ID ${device.id} has already been added`);
            return;
        }

        // get the device delegate class for this device
        const cls = DeviceDelegate.getDelegate(device.model);
        if (cls === undefined) {
            // a ds9-known model without a plugin delegate (the library never
            // emits 'add' for models it does not know)
            this.handleUnknownDevice(device.id, device.model);
            if (this.options.bthome.enable) {
                const opts = { ...this.options.getDeviceOptions(device.id) };
                if (!opts.name) {
                    opts.name = device.system.config?.device?.name;
                }
                this.bthomeDelegates.set(device.id, new BTHomeHostDelegate(device, opts, this));
                // Persist the host so its cached peripheral accessories can
                // be re-discovered after a restart even without mDNS. The
                // library only re-adds models it knows, so this applies to
                // ds9-known models without a plugin delegate.
                this.deviceCache.storeDevice(device);
            }
            return;
        }

        // get the configuration options for this device (and copy them)
        const opts = { ...this.options.getDeviceOptions(device.id) };

        // if no name has been specified...
        if (!opts.name) {
            // use the name from the API
            opts.name = device.system.config?.device?.name;
        }

        // create a delegate for this device
        const delegate = new cls(device, opts, this);

        // store the delegate
        this.deviceDelegates.set(device.id, delegate);

        // Hosted BTHome components are opt-in. The BLU Gateway delegate already
        // owns its BTHome accessories; other supported hosts get a companion.
        if (this.options.bthome.enable && cls !== ShellyBluGatewayDelegate) {
            this.bthomeDelegates.set(device.id, new BTHomeHostDelegate(device, opts, this));
        }

        // store info about this device in cache
        this.deviceCache.storeDevice(device);
    }

    /**
     * Handles 'remove' events from the shellies-ds9 library.
     */
    protected handleRemovedDevice(device: Device) {
        if (this.shuttingDown) {
            return;
        }
        this.bthomeDelegates.get(device.id)?.destroy();
        this.bthomeDelegates.delete(device.id);

        // destroy and remove the device delegate
        this.deviceDelegates.get(device.id)?.destroy();
        this.deviceDelegates.delete(device.id);

        // Reconcile any cached peripheral left behind when the host was not
        // available long enough to create its companion delegate.
        this.removeAccessory(...this.getBTHomeAccessories(device.id));

        // delete this device from cache
        this.deviceCache.delete(device.id);
    }

    /**
     * Handles 'exclude' events from the shellies-ds9 library.
     */
    protected handleExcludedDevice(deviceId: DeviceId) {
        if (this.shuttingDown) {
            return;
        }
        this.log.info(`[${deviceId}] Device excluded`);

        // delete this device from cache
        this.deviceCache.delete(deviceId);

        this.bthomeDelegates.get(deviceId)?.destroy();
        this.bthomeDelegates.delete(deviceId);

        if (this.deviceDelegates.has(deviceId)) {
            // destroy and remove the device delegate
            this.deviceDelegates.get(deviceId)!.destroy();
            this.deviceDelegates.delete(deviceId);
        }

        // Find any remaining platform accessories, including cached BTHome
        // accessories that had no live manager delegate.
        const pas = Array.from(this.accessories.values()).filter((pa) => pa.context.device?.id === deviceId);
        if (pas.length > 0) {
            this.removeAccessory(...pas);
        }
        this.log.debug(
            pas.length === 1 ? '1 platform accessory unregistered' : `${pas.length} platform accessories unregistered`,
        );
    }

    /**
     * Handles 'unknown' events from the shellies-ds9 library.
     */
    protected handleUnknownDevice(deviceId: DeviceId, model: string) {
        this.log.warn(`[${deviceId}] Unknown device of model "${model}" discovered.`);
    }

    /**
     * Handles 'error' events from the shellies-ds9 library.
     */
    protected handleError(deviceId: DeviceId, error: Error) {
        // print the error to the log
        this.log.error(error.message);
        this.log.debug(error.stack || '');
    }
}
