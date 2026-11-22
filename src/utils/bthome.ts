import { DynamicComponent } from '@lucavb/shellies-ds9';
import type { Characteristic, Service, WithUUID } from 'homebridge';

export type BTHomeSensorKind = 'temperature' | 'humidity' | 'contact' | 'motion' | 'battery';

/** Keys on `api.hap.Characteristic` that resolve to a characteristic constructor. */
export type BTHomeCharacteristicName = {
    [K in keyof typeof Characteristic]: (typeof Characteristic)[K] extends WithUUID<new () => Characteristic>
        ? K
        : never;
}[keyof typeof Characteristic];

/** Keys on `api.hap.Service` that resolve to a service constructor. */
export type BTHomeServiceName = {
    [K in keyof typeof Service]: (typeof Service)[K] extends WithUUID<new () => Service> ? K : never;
}[keyof typeof Service];

/**
 * The single source of truth for how a BTHome sensor kind maps to HomeKit.
 * `serviceName` is the key of the HAP service constructor on `api.hap.Service`,
 * `characteristics` are the keys of the HAP characteristic constructors on
 * `api.hap.Characteristic` that expose the reading (battery intentionally
 * maps to two characteristics). The platform, the sensor ability, and the
 * stale-service invalidation all consume this table, so a new kind cannot be
 * silently skipped by any of them.
 */
export interface BTHomeSensorKindDescriptor {
    displayName: string;
    serviceName: BTHomeServiceName;
    characteristics: readonly BTHomeCharacteristicName[];
}

export const bthomeSensorKindDescriptors: Record<BTHomeSensorKind, BTHomeSensorKindDescriptor> = {
    temperature: {
        displayName: 'Temperature',
        serviceName: 'TemperatureSensor',
        characteristics: ['CurrentTemperature'],
    },
    humidity: {
        displayName: 'Humidity',
        serviceName: 'HumiditySensor',
        characteristics: ['CurrentRelativeHumidity'],
    },
    contact: {
        displayName: 'Contact',
        serviceName: 'ContactSensor',
        characteristics: ['ContactSensorState'],
    },
    motion: {
        displayName: 'Motion',
        serviceName: 'MotionSensor',
        characteristics: ['MotionDetected'],
    },
    battery: {
        displayName: 'Battery',
        serviceName: 'Battery',
        characteristics: ['BatteryLevel', 'StatusLowBattery'],
    },
};

/**
 * Parses the sensor kind encoded in a BTHome service subtype
 * (`bthome-${kind}-${objectId}-${index}`). Returns `undefined` for button
 * services (`bthome-button-${index}`) and unknown kinds, which have no
 * readable value to invalidate.
 */
export function parseBTHomeSensorKind(subtype: string | undefined): BTHomeSensorKind | undefined {
    if (typeof subtype !== 'string' || !subtype.startsWith('bthome-')) {
        return undefined;
    }
    const kind = subtype.split('-')[1] as BTHomeSensorKind;
    return kind in bthomeSensorKindDescriptors ? kind : undefined;
}

/**
 * Reads either timestamp spelling encountered in BTHome RPC references. `null`
 * signals malformed/conflicting fields; `undefined` means neither is present.
 */
export function getBTHomeLastUpdatedTimestamp(status: unknown): number | null | undefined {
    if (status === null || typeof status !== 'object' || Array.isArray(status)) {
        return undefined;
    }
    const record = status as { last_update_ts?: unknown; last_updated_ts?: unknown };
    const hasSingular = Object.hasOwn(record, 'last_update_ts');
    const hasPlural = Object.hasOwn(record, 'last_updated_ts');
    if (!hasSingular && !hasPlural) {
        return undefined;
    }

    const singular = record.last_update_ts;
    const plural = record.last_updated_ts;
    if (
        (hasSingular && (typeof singular !== 'number' || !Number.isFinite(singular))) ||
        (hasPlural && (typeof plural !== 'number' || !Number.isFinite(plural)))
    ) {
        return null;
    }
    if (hasSingular && hasPlural && singular !== plural) {
        return null;
    }
    return (hasSingular ? singular : plural) as number;
}

export interface BTHomeSensorConfig {
    address: string;
    objectId: number;
    index: number;
}

export interface BTHomePeripheral {
    address: string;
    devices: DynamicComponent[];
    sensors: Array<{ component: DynamicComponent; config: BTHomeSensorConfig }>;
}

/** Normalizes and validates the stable six-octet BLE address reported by BTHome. */
export function parseBTHomeAddress(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const normalized = value.trim().replaceAll('-', ':').toLowerCase();
    return /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized) ? normalized : undefined;
}

/** Extracts the identity tuple Shelly reports for a BTHome sensor. */
export function parseBTHomeSensorConfig(component: DynamicComponent): BTHomeSensorConfig | undefined {
    if (!/^bthomesensor:\d+$/i.test(component.key)) {
        return undefined;
    }

    const config = component.config;
    const address = parseBTHomeAddress(config?.addr);
    const objectId = config?.obj_id;
    const index = config?.idx;

    if (
        address === undefined ||
        typeof objectId !== 'number' ||
        !Number.isSafeInteger(objectId) ||
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0
    ) {
        return undefined;
    }

    return { address, objectId, index };
}

/** Only object IDs with a well-defined HomeKit temperature/humidity mapping are exposed. */
export function getBTHomeSensorKind(objectId: number): BTHomeSensorKind | undefined {
    switch (objectId) {
        case 1: // battery level, percent
            return 'battery';
        case 2: // temperature, 0.01 °C resolution
        case 69: // temperature, 0.1 °C resolution
            return 'temperature';
        case 3: // humidity, 0.01% resolution
        case 46: // humidity, 1% resolution
            return 'humidity';
        case 33: // motion, binary (0 clear, 1 detected)
            return 'motion';
        case 45: // window/contact, binary (0 closed, 1 open)
            return 'contact';
        default:
            return undefined;
    }
}

/**
 * Groups dynamic components by their verified peripheral address. Sensor
 * components are deduplicated by the complete (addr, obj_id, idx) identity.
 */
export function groupBTHomeComponents(components: Iterable<DynamicComponent>): Map<string, BTHomePeripheral> {
    const grouped = new Map<string, BTHomePeripheral>();

    const getPeripheral = (address: string): BTHomePeripheral => {
        let peripheral = grouped.get(address);
        if (!peripheral) {
            peripheral = { address, devices: [], sensors: [] };
            grouped.set(address, peripheral);
        }
        return peripheral;
    };

    for (const component of components) {
        if (component instanceof DynamicComponent && /^bthomedevice:\d+$/i.test(component.key)) {
            const address = parseBTHomeAddress(component.config?.addr);
            if (address !== undefined) {
                getPeripheral(address).devices.push(component);
            }
            continue;
        }

        if (!(component instanceof DynamicComponent)) {
            continue;
        }

        const config = parseBTHomeSensorConfig(component);
        if (config === undefined) {
            continue;
        }

        const peripheral = getPeripheral(config.address);
        if (
            peripheral.sensors.some(
                (sensor) => sensor.config.objectId === config.objectId && sensor.config.index === config.index,
            )
        ) {
            continue;
        }
        peripheral.sensors.push({ component, config });
    }

    return grouped;
}

/** Returns true only when Shelly explicitly reports BTHome button object ID 58. */
export function getKnownBTHomeButtonIndexes(response: unknown): number[] | undefined {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        return undefined;
    }

    const objects = (response as { objects?: unknown }).objects;
    if (!Array.isArray(objects)) {
        return undefined;
    }

    const indexes = new Set<number>();
    for (const object of objects) {
        if (object === null || typeof object !== 'object' || Array.isArray(object)) {
            return undefined;
        }
        const { obj_id: objectId, idx } = object as { obj_id?: unknown; idx?: unknown };
        if (typeof objectId !== 'number' || !Number.isSafeInteger(objectId)) {
            return undefined;
        }
        if (objectId !== 58) {
            continue;
        }
        if (typeof idx !== 'number' || !Number.isSafeInteger(idx) || idx < 0) {
            return undefined;
        }
        indexes.add(idx);
    }

    return Array.from(indexes).sort((a, b) => a - b);
}
