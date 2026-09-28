import { DeviceId } from '@lucavb/shellies-ds9';
import { Categories } from 'homebridge';
import type { PlatformAccessory } from 'homebridge';

import { Ability } from './abilities/index.ts';
import { createRecorder } from './history.ts';
import type { HistoryKind, WeatherHistoryRecorder } from './history.ts';
import { DeviceLogger } from './utils/device-logger.ts';
import { ShellyPlatform } from './platform.ts';

export type AccessoryId = string;
export type AccessoryUuid = string;

/**
 * The categories that the accessory category resolution prefers, in order.
 * The semantics of the old, tier-based instanceof chain are preserved for
 * every reachable configuration: for each tier, all active abilities are
 * scanned and the first tier that any of them declares wins. (Within the
 * cover tier, the old chain resolved the first active cover ability in list
 * order, while this order resolves by type priority; delegates never
 * activate more than one cover ability, so the two cannot diverge.)
 */
const CATEGORY_TIERS: Categories[] = [
    Categories.OUTLET,
    Categories.SWITCH,
    Categories.LIGHTBULB,
    Categories.DOOR,
    Categories.WINDOW,
    Categories.WINDOW_COVERING,
    Categories.PROGRAMMABLE_SWITCH,
    Categories.SENSOR,
];

/**
 * Determines the category of a HomeKit accessory from its abilities.
 * The first category, according to the fixed `CATEGORY_TIERS` order, that an
 * active ability declares wins; if none does, the accessory falls back to
 * `Categories.OTHER`.
 * @param abilities - The abilities to derive the category from.
 */
export function resolveAccessoryCategory(abilities: Ability[]): Categories {
    const active = abilities.filter((a) => a.active);

    for (const tier of CATEGORY_TIERS) {
        if (active.some((a) => a.category === tier)) {
            return tier;
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

    private homebridgeAccessory: PlatformAccessory | null;

    /**
     * The underlying homebridge platform accessory.
     * This property will be `null` when the accessory is inactive.
     */
    get platformAccessory(): PlatformAccessory | null {
        return this.homebridgeAccessory;
    }

    /**
     * Holds this accessory's abilities.
     */
    readonly abilities: Ability[];

    private activeState = true;

    /**
     * Whether this accessory is active.
     * Setting an accessory to inactive will remove it from HoneKit.
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
     * Timeout used to delay calls to `update()`.
     */
    protected updateTimeout: ReturnType<typeof setTimeout> | null = null;

    /**
     * The weather history recorder for this accessory, or `null` if history
     * support has not been set up (or has been torn down).
     */
    private recorder: WeatherHistoryRecorder | null = null;

    /**
     * @param id - The accessory ID.
     * @param deviceId - The associated device ID.
     * @param name - A user-friendly name of the accessory.
     * @param platform - A reference to the homebridge platform.
     * @param log - The logger to use.
     * @param abilities - The abilities that this accessory has.
     */
    constructor(
        readonly id: AccessoryId,
        readonly deviceId: DeviceId,
        readonly name: string,
        readonly platform: ShellyPlatform,
        readonly log: DeviceLogger,
        ...abilities: Ability[]
    ) {
        this.uuid = platform.api.hap.uuid.generate(`${deviceId}-${id}`);
        this.abilities = abilities;

        // try to load the platform accessory from cache
        this.homebridgeAccessory = platform.getAccessory(this.uuid) || null;
        if (this.homebridgeAccessory !== null) {
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
        if (this.homebridgeAccessory === null) {
            // create a new platform accessory
            this.homebridgeAccessory = this.createPlatformAccessory();

            this.log.debug(`Accessory activated (ID: ${this.id})`);
        }

        // set up the weather history recorder before the abilities are set up,
        // so that the abilities' setup-time seedings of their characteristics
        // are recorded as well
        // this is attempted even when no ability records history: the recorder
        // is inert then, and it removes any stale history service that a cached
        // platform accessory may still be carrying
        const kinds: HistoryKind[] = [];
        for (const a of this.abilities) {
            const kind = a.historyKind;
            if (kind !== undefined) {
                kinds.push(kind);
            }
        }
        this.recorder = createRecorder(this.homebridgeAccessory, this.platform.api, this.uuid, this.log, kinds);

        // attach the recorder to the abilities that record history
        for (const a of this.abilities) {
            if (a.historyKind !== undefined) {
                a.setRecorder(this.recorder);
            }
        }

        // setup all abilities
        for (const a of this.abilities) {
            try {
                a.setup(this.homebridgeAccessory, this.platform, this.log);
            } catch (e) {
                this.log.error('Failed to setup ability:', e instanceof Error ? e.message : e);
                this.log.debug('Accessory ID:', this.id);
                if (e instanceof Error && e.stack) {
                    this.log.debug(e.stack);
                }
            }
        }

        // register the platform accessory
        this.platform.addAccessory(this.homebridgeAccessory);
    }

    /**
     * Completes the weather history teardown, by detaching the recorder from
     * the fakegato global registries.
     * Note that no persisted history data is removed; a sensor that is disabled
     * or removed will leave a stale (harmless) history file behind.
     */
    private detachHistory() {
        if (this.recorder !== null) {
            this.recorder.detach();
            this.recorder = null;
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

        if (this.homebridgeAccessory !== null) {
            // unregister the platform accessory
            this.platform.removeAccessory(this.homebridgeAccessory);
            this.homebridgeAccessory = null;

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
