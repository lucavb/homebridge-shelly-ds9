import { DeviceId } from '@lucavb/shellies-ds9';
import { Categories } from 'homebridge';
import type { CharacteristicChange, PlatformAccessory } from 'homebridge';

import {
    Ability,
    CoverAbility,
    HumiditySensorAbility,
    LightAbility,
    OutletAbility,
    ReadonlySwitchAbility,
    StatelessProgrammableSwitchAbility,
    SwitchAbility,
    TemperatureSensorAbility,
} from './abilities/index.ts';
import { WEATHER_HISTORY_SERVICE_UUID, makeHistoryService, removeFromFakegatoRegistries } from './history.ts';
import type { FakeGatoHistoryService, HistoryOptions } from './history.ts';
import { DeviceLogger } from './utils/device-logger.ts';
import { ShellyPlatform, resolveStoragePath } from './platform.ts';

export type AccessoryId = string;
export type AccessoryUuid = string;

export function resolveAccessoryCategory(abilities: Ability[]): Categories {
    const active = abilities.filter((a) => a.active);

    for (const a of active) {
        if (a instanceof OutletAbility) {
            return Categories.OUTLET;
        }
    }
    for (const a of active) {
        if (a instanceof SwitchAbility || a instanceof ReadonlySwitchAbility) {
            return Categories.SWITCH;
        }
    }
    for (const a of active) {
        if (a instanceof LightAbility) {
            return Categories.LIGHTBULB;
        }
    }
    for (const a of active) {
        if (a instanceof CoverAbility) {
            if (a.type === 'door') {
                return Categories.DOOR;
            }
            if (a.type === 'window') {
                return Categories.WINDOW;
            }
            return Categories.WINDOW_COVERING;
        }
    }
    for (const a of active) {
        if (a instanceof StatelessProgrammableSwitchAbility) {
            return Categories.PROGRAMMABLE_SWITCH;
        }
    }
    for (const a of active) {
        if (a instanceof TemperatureSensorAbility || a instanceof HumiditySensorAbility) {
            return Categories.SENSOR;
        }
    }

    return Categories.OTHER;
}

/**
 * Represents a HomeKit accessory.
 */
export class Accessory {
    /**
     * The UUID used to identify this accessory with HomeKit.
     */
    readonly uuid: AccessoryUuid;

    protected _platformAccessory: PlatformAccessory | null;

    /**
     * The underlying homebridge platform accessory.
     * This property will be `null` when the accessory is inactive.
     */
    get platformAccessory(): PlatformAccessory | null {
        return this._platformAccessory;
    }

    /**
     * Holds this accessory's abilities.
     */
    readonly abilities: Ability[];

    private _active = true;

    /**
     * Whether this accessory is active.
     * Setting an accessory to inactive will remove it from HoneKit.
     */
    get active(): boolean {
        return this._active;
    }

    set active(value) {
        if (value === this._active) {
            return;
        }

        this._active = value;
        this.update();
    }

    /**
     * Timeout used to delay calls to `update()`.
     */
    protected updateTimeout: ReturnType<typeof setTimeout> | null = null;

    /**
     * Handles used to complete the fakegato history teardown, including the
     * characteristic change listeners that feed the history service, or `null`
     * if no history is currently recorded.
     */
    private historyState: {
        detach: () => void;
        api: ShellyPlatform['api'];
        historyService: FakeGatoHistoryService;
    } | null = null;

    /**
     * @param id - The accessory ID.
     * @param deviceId - The associated device ID.
     * @param name - A user-friendly name of the accessory.
     * @param platform - A reference to the homebridge platform.
     * @param log - The logger to use.
     * @param history - Options for recording fakegato history data.
     * @param abilities - The abilities that this accessory has.
     */
    constructor(
        readonly id: AccessoryId,
        readonly deviceId: DeviceId,
        readonly name: string,
        readonly platform: ShellyPlatform,
        readonly log: DeviceLogger,
        readonly history?: HistoryOptions,
        ...abilities: Ability[]
    ) {
        this.uuid = platform.api.hap.uuid.generate(`${deviceId}-${id}`);
        this.abilities = abilities;

        // try to load the platform accessory from cache
        this._platformAccessory = platform.getAccessory(this.uuid) || null;
        if (this._platformAccessory !== null) {
            log.debug(`Accessory loaded from cache (ID: ${id})`);
        }

        this.update();
    }

    /**
     * Sets `active` to the given value.
     * This method can be used when chaining calls, as it returns a reference to `this`.
     * @param value - Whether the accessory should be active.
     */
    setActive(value: boolean): this {
        this.active = value;
        return this;
    }

    /**
     * Updates this accessory based on whether it is active.
     */
    protected update() {
        // clear any running timeout
        if (this.updateTimeout !== null) {
            clearTimeout(this.updateTimeout);
        }

        // call either activate() or deactivate() depending on whether the accessory is active
        // these calls are made after a short timeout to avoid unnecessary activations when an
        // accessory is deactivated immediately after construction
        this.updateTimeout = setTimeout(() => {
            this.updateTimeout = null;

            if (this.active) {
                this.activate();
            } else {
                this.deactivate();
            }
        }, 0);
    }

    /**
     * Activates this accessory, by creating a platform accessory and setting up all abilities.
     */
    protected activate() {
        if (this._platformAccessory === null) {
            // create a new platform accessory
            this._platformAccessory = this.createPlatformAccessory();

            this.log.debug(`Accessory activated (ID: ${this.id})`);
        }

        // setup all abilities
        for (const a of this.abilities) {
            try {
                a.setup(this._platformAccessory, this.platform, this.log);
            } catch (e) {
                this.log.error('Failed to setup ability:', e instanceof Error ? e.message : e);
                this.log.debug('Accessory ID:', this.id);
                if (e instanceof Error && e.stack) {
                    this.log.debug(e.stack);
                }
            }
        }

        // setup the fakegato history service (if applicable)
        try {
            this.setupHistory();
        } catch (e) {
            this.log.error('Failed to setup history:', e instanceof Error ? e.message : e);
            this.log.debug('Accessory ID:', this.id);
            if (e instanceof Error && e.stack) {
                this.log.debug(e.stack);
            }
        }

        // register the platform accessory
        this.platform.addAccessory(this._platformAccessory);
    }

    /**
     * Sets up the fakegato history service for this accessory, if it exposes
     * temperature and/or humidity sensor abilities and history is enabled for
     * them.
     * At most one weather history service is created per accessory, and its
     * characteristic change events are fed to it as history entries.
     */
    private setupHistory() {
        const pa = this._platformAccessory;
        if (pa === null) {
            return;
        }

        const temperatureAbility = this.abilities.find(
            (a): a is TemperatureSensorAbility => a instanceof TemperatureSensorAbility,
        );
        const humidityAbility = this.abilities.find(
            (a): a is HumiditySensorAbility => a instanceof HumiditySensorAbility,
        );

        // a missing flag means that history is enabled
        const recordTemperature = temperatureAbility !== undefined && (this.history?.temp ?? true);
        const recordHumidity = humidityAbility !== undefined && (this.history?.humidity ?? true);

        if (!recordTemperature && !recordHumidity) {
            // the accessory may have been loaded from cache with a history
            // service created while history was still enabled, so remove it
            // (mirrors the cached-service cleanup in `Ability.removeService()`)
            const frozenService = pa.services.find((s) => s.UUID === WEATHER_HISTORY_SERVICE_UUID);
            if (frozenService !== undefined) {
                try {
                    pa.removeService(frozenService);
                } catch (e) {
                    this.log.debug(
                        'Failed to remove the disabled history service:',
                        e instanceof Error ? e.message : e,
                    );
                }
            }
            return;
        }

        const api = this.platform.api;

        const storagePath = resolveStoragePath(api);
        if (storagePath === undefined) {
            this.log.debug('Skipping history support: could not determine the storage path');
            return;
        }

        const historyService = makeHistoryService(api, 'weather', pa, {
            log: this.log,
            storage: 'fs',
            path: storagePath,
            filename: `${this.uuid}.json`,
        });

        if (historyService === null) {
            return;
        }

        // the fakegato history service registers itself on the platform
        // accessory during construction (fresh and cached accessories alike),
        // so the history data is immediately available to the Eve and Home+ apps

        const cleanups: (() => void)[] = [];

        if (recordTemperature) {
            const service = pa.getService(api.hap.Service.TemperatureSensor);
            const characteristic = service?.getCharacteristic(api.hap.Characteristic.CurrentTemperature);

            if (characteristic !== undefined) {
                const addEntry = (value: number) => {
                    historyService.addEntry({ time: Math.floor(Date.now() / 1000), temp: value });
                };

                // push an initial entry if the characteristic already holds a value
                const initialValue = characteristic.value;
                if (typeof initialValue === 'number' && Number.isFinite(initialValue)) {
                    addEntry(initialValue);
                }

                const listener = (change: CharacteristicChange) => {
                    const value = change.newValue;
                    if (typeof value === 'number' && Number.isFinite(value)) {
                        addEntry(value);
                    }
                };

                characteristic.on('change', listener);
                cleanups.push(() => characteristic.removeListener('change', listener));
            }
        }

        if (recordHumidity) {
            const service = pa.getService(api.hap.Service.HumiditySensor);
            const characteristic = service?.getCharacteristic(api.hap.Characteristic.CurrentRelativeHumidity);

            if (characteristic !== undefined) {
                const addEntry = (value: number) => {
                    historyService.addEntry({ time: Math.floor(Date.now() / 1000), humidity: value });
                };

                const initialValue = characteristic.value;
                if (typeof initialValue === 'number' && Number.isFinite(initialValue)) {
                    addEntry(initialValue);
                }

                const listener = (change: CharacteristicChange) => {
                    const value = change.newValue;
                    if (typeof value === 'number' && Number.isFinite(value)) {
                        addEntry(value);
                    }
                };

                characteristic.on('change', listener);
                cleanups.push(() => characteristic.removeListener('change', listener));
            }
        }

        this.historyState = {
            detach: () => {
                for (const cleanup of cleanups) {
                    try {
                        cleanup();
                    } catch {
                        // ignore errors from listener removal
                    }
                }
            },
            api,
            historyService,
        };
    }

    /**
     * Completes the fakegato history teardown, by removing the characteristic
     * change listeners that feed the history service and by removing the
     * service from the global fakegato timer and storage registries.
     * Note that no persisted history data is removed; a sensor that is disabled
     * or removed will leave a stale (harmless) history file behind.
     */
    private detachHistory() {
        if (this.historyState !== null) {
            const state = this.historyState;
            this.historyState = null;

            state.detach();
            removeFromFakegatoRegistries(state.api, state.historyService);
        }
    }

    /**
     * Deactivates this accessory, by destroying all abilities and the platform accessory.
     */
    protected deactivate() {
        // stop recording history data
        this.detachHistory();

        // destroy all abilities
        for (const a of this.abilities) {
            try {
                a.destroy();
            } catch (e) {
                this.log.error('Failed to destroy ability:', e instanceof Error ? e.message : e);
                this.log.debug('Accessory ID:', this.id);
                if (e instanceof Error && e.stack) {
                    this.log.debug(e.stack);
                }
            }
        }

        if (this._platformAccessory !== null) {
            // unregister the platform accessory
            this.platform.removeAccessory(this._platformAccessory);
            this._platformAccessory = null;

            this.log.debug(`Accessory deactivated (ID: ${this.id})`);
        }
    }

    /**
     * Creates a new platform accessory for this accessory.
     */
    protected createPlatformAccessory(): PlatformAccessory {
        const category = resolveAccessoryCategory(this.abilities);
        const pa = new this.platform.api.platformAccessory(this.name, this.uuid, category);

        // store info in the context
        pa.context.device = {
            id: this.deviceId,
        };

        return pa;
    }

    /**
     * Removes all event listeners from this accessory.
     */
    detach() {
        // abort any pending update
        if (this.updateTimeout !== null) {
            clearTimeout(this.updateTimeout);
            this.updateTimeout = null;
        }

        // stop recording history data
        this.detachHistory();

        // invoke detach() on all abilities
        for (const a of this.abilities) {
            try {
                a.detach();
            } catch (e) {
                this.log.error('Failed to detach ability:', e instanceof Error ? e.message : e);
                this.log.debug('Accessory ID:', this.id);
                if (e instanceof Error && e.stack) {
                    this.log.debug(e.stack);
                }
            }
        }
    }
}
