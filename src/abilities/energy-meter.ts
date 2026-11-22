import { EM, EM1, EM1Data, EMData } from '@lucavb/shellies-ds9';
import { Service } from 'homebridge';

import type { CustomCharacteristics } from '../utils/characteristics.ts';
import { Ability, ServiceClass } from './base.ts';

type MeasurementName = 'power' | 'consumption' | 'current' | 'voltage' | 'imported' | 'exported';
type Readings = Partial<Record<MeasurementName, number>>;

interface MonoPhase {
    meter: EM1;
    data?: EM1Data;
}

interface ThreePhase {
    meter: EM;
    data?: EMData;
}

interface PhaseReading {
    name: string;
    readings: Readings;
}

interface ObservableComponent {
    on(event: string, listener: (...args: unknown[]) => void, context?: unknown): unknown;
    off(event: string, listener: (...args: unknown[]) => void, context?: unknown): unknown;
}

/**
 * Measurement bounds for this meter. The shared characteristic classes carry
 * smaller maxima for their existing consumers, so these wider ranges are
 * reapplied to each service instance in markUnavailable().
 */
const MEASUREMENTS: Record<MeasurementName, { unit: string; min: number; max: number }> = {
    power: { unit: 'W', min: -100000, max: 100000 },
    consumption: { unit: 'W', min: 0, max: 100000 },
    current: { unit: 'A', min: 0, max: 1000 },
    voltage: { unit: 'V', min: 0, max: 1000 },
    imported: { unit: 'kWh', min: 0, max: 100000000 },
    exported: { unit: 'kWh', min: 0, max: 100000000 },
};

const WH_PER_KWH = 1000;

/**
 * Maps each measurement to its shared characteristic class, registered once
 * by the platform instead of per ability instance.
 */
const CHARACTERISTIC_KEYS: Record<MeasurementName, keyof CustomCharacteristics> = {
    power: 'SignedNetPower',
    consumption: 'CurrentConsumption',
    current: 'ElectricCurrent',
    voltage: 'Voltage',
    imported: 'TotalConsumption',
    exported: 'ExportedEnergy',
};

/**
 * Exposes meter readings through Eve-compatible CurrentConsumption,
 * TotalConsumption, Voltage and ElectricCurrent characteristics where those
 * unsigned characteristics represent the measurement. Signed net power and
 * exported energy use plugin-owned characteristics, not Eve characteristics.
 * Negative net power is reported as zero CurrentConsumption plus the actual
 * negative Signed Net Power; exported energy is never folded into import.
 *
 * For single-phase meter profiles, all three channels must be available before
 * an aggregate is published. A profile switch replaces component instances,
 * so profile changes require a Homebridge restart to rebuild the accessory.
 */
export class EnergyMeterAbility extends Ability {
    private readonly phaseServices = new Map<string, Service>();
    private readonly listeners: Array<{ component: ObservableComponent; event: string }> = [];
    private stale = false;
    private servicesInitialized = false;

    constructor(
        readonly profile: 'triphase' | 'monophase',
        readonly source: ThreePhase | readonly [MonoPhase, MonoPhase, MonoPhase],
    ) {
        super('Shelly Energy Meter', 'shelly-energy-meter');
    }

    protected get serviceClass(): ServiceClass {
        return this.customServices.ThreePhaseMeter;
    }

    protected initialize() {
        this.markUnavailable(this.service);

        if (this.profile === 'triphase') {
            const source = this.source as ThreePhase;
            for (const [name, key] of [
                ['Phase A', 'a'],
                ['Phase B', 'b'],
                ['Phase C', 'c'],
            ] as const) {
                const phaseService = this.addPhaseService(name, key.toLowerCase());
                this.markUnavailable(phaseService);
                this.listenTo(source.meter, [
                    `${key.toLowerCase()}_act_power`,
                    `${key.toLowerCase()}_current`,
                    `${key.toLowerCase()}_voltage`,
                ]);
                if (source.data) {
                    this.listenTo(source.data, [
                        `${key.toLowerCase()}_total_act_energy`,
                        `${key.toLowerCase()}_total_act_ret_energy`,
                    ]);
                }
            }
            this.listenTo(source.meter, ['total_act_power', 'total_current']);
            if (source.data) {
                this.listenTo(source.data, ['total_act', 'total_act_ret']);
            }
        } else {
            const phases = this.source as readonly [MonoPhase, MonoPhase, MonoPhase];
            phases.forEach(({ meter, data }, index) => {
                const suffix = String.fromCharCode(97 + index);
                const phaseService = this.addPhaseService(`Phase ${suffix.toUpperCase()}`, suffix);
                this.markUnavailable(phaseService);
                this.listenTo(meter, ['act_power', 'current', 'voltage']);
                if (data) {
                    this.listenTo(data, ['total_act_energy', 'total_act_ret_energy']);
                }
            });
        }

        this.servicesInitialized = true;
        if (!this.stale) {
            this.refreshReadings();
        }
    }

    /**
     * Returns whether this ability's bound components were replaced in the
     * device inventory, as happens when a meter profile changes at runtime.
     */
    hasReplacedComponents(getComponent: (key: string) => unknown): boolean {
        const components =
            this.profile === 'triphase'
                ? [(this.source as ThreePhase).meter, (this.source as ThreePhase).data]
                : (this.source as readonly [MonoPhase, MonoPhase, MonoPhase]).flatMap(({ meter, data }) => [
                      meter,
                      data,
                  ]);
        return components.some((component) => component !== undefined && getComponent(component.key) !== component);
    }

    /** Stop reporting values from detached instances and require a restart. */
    markStale() {
        this.stale = true;
        this.detach();
        if (this.servicesInitialized) {
            this.markUnavailable(this.service);
            for (const service of this.phaseServices.values()) {
                this.markUnavailable(service);
            }
        }
    }

    private addPhaseService(name: string, suffix: string) {
        const subtype = `shelly-energy-meter-phase-${suffix}`;
        const service =
            this.platformAccessory.getServiceById(this.serviceClass, subtype) ??
            this.platformAccessory.addService(this.serviceClass, `${this.serviceName} ${name}`, subtype);
        this.phaseServices.set(suffix, service);
        return service;
    }

    private markUnavailable(service: Service) {
        const cc = this.customCharacteristics;
        for (const key of Object.keys(MEASUREMENTS) as MeasurementName[]) {
            const definition = MEASUREMENTS[key];
            const characteristic = service.getCharacteristic(cc[CHARACTERISTIC_KEYS[key]]);
            // Cached HAP services retain the characteristic instance and its
            // old props, so reapply this meter's safe bounds after restoration.
            characteristic.setProps({
                format: this.platform.api.hap.Formats.FLOAT,
                perms: [this.platform.api.hap.Perms.NOTIFY, this.platform.api.hap.Perms.PAIRED_READ],
                unit: definition.unit,
                minValue: definition.min,
                maxValue: definition.max,
                minStep: 0.001,
            });
            characteristic.updateValue(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY));
        }
    }

    private listenTo(component: ObservableComponent, properties: string[]) {
        if (this.stale) {
            return;
        }
        for (const property of properties) {
            const event = `change:${property}`;
            component.on(event, this.componentChangeHandler, this);
            this.listeners.push({ component, event });
        }
    }

    private readonly componentChangeHandler = () => this.refreshReadings();

    private static present(value: number | null | undefined): value is number {
        return typeof value === 'number' && Number.isFinite(value);
    }

    private static whToKwh(value: number | null | undefined): number | undefined {
        return EnergyMeterAbility.present(value) ? value / WH_PER_KWH : undefined;
    }

    private refreshReadings() {
        if (this.stale) {
            return;
        }
        if (this.profile === 'triphase') {
            this.refreshTriphase(this.source as ThreePhase);
        } else {
            this.refreshMonophase(this.source as readonly [MonoPhase, MonoPhase, MonoPhase]);
        }
    }

    private refreshTriphase({ meter, data }: ThreePhase) {
        const phases: PhaseReading[] = [
            {
                name: 'a',
                readings: this.reading(
                    meter.a_act_power,
                    meter.a_current,
                    meter.a_voltage,
                    data?.a_total_act_energy,
                    data?.a_total_act_ret_energy,
                ),
            },
            {
                name: 'b',
                readings: this.reading(
                    meter.b_act_power,
                    meter.b_current,
                    meter.b_voltage,
                    data?.b_total_act_energy,
                    data?.b_total_act_ret_energy,
                ),
            },
            {
                name: 'c',
                readings: this.reading(
                    meter.c_act_power,
                    meter.c_current,
                    meter.c_voltage,
                    data?.c_total_act_energy,
                    data?.c_total_act_ret_energy,
                ),
            },
        ];
        for (const phase of phases) {
            this.publish(this.phaseServices.get(phase.name), phase.readings);
        }

        const aggregate: Readings = {};
        this.assignPower(aggregate, meter.total_act_power);
        this.assign(aggregate, 'current', meter.total_current);
        this.assign(aggregate, 'imported', EnergyMeterAbility.whToKwh(data?.total_act));
        this.assign(aggregate, 'exported', EnergyMeterAbility.whToKwh(data?.total_act_ret));
        this.publish(this.service, aggregate);
    }

    private refreshMonophase(phases: readonly [MonoPhase, MonoPhase, MonoPhase]) {
        const phaseReadings = phases.map(({ meter, data }, index) => {
            const suffix = String.fromCharCode(97 + index);
            const readings = this.reading(
                meter.act_power,
                meter.current,
                meter.voltage,
                data?.total_act_energy,
                data?.total_act_ret_energy,
            );
            this.publish(this.phaseServices.get(suffix), readings);
            return readings;
        });

        const aggregate: Readings = {};
        for (const key of ['power', 'imported', 'exported'] as const) {
            const values = phaseReadings.map((readings) => readings[key]);
            // Do not publish a partial sum as the meter's aggregate value.
            if (values.every((value): value is number => value !== undefined)) {
                const total = values.reduce((sum, value) => sum + value, 0);
                if (key === 'power') {
                    this.assignPower(aggregate, total);
                } else {
                    this.assign(aggregate, key, total);
                }
            }
        }
        this.publish(this.service, aggregate);
    }

    private reading(
        power?: number | null,
        current?: number | null,
        voltage?: number | null,
        importedWh?: number | null,
        exportedWh?: number | null,
    ): Readings {
        const readings: Readings = {};
        this.assignPower(readings, power);
        this.assign(readings, 'current', current);
        this.assign(readings, 'voltage', voltage);
        this.assign(readings, 'imported', EnergyMeterAbility.whToKwh(importedWh));
        this.assign(readings, 'exported', EnergyMeterAbility.whToKwh(exportedWh));
        return readings;
    }

    private assign(readings: Readings, key: MeasurementName, value: number | null | undefined) {
        const { min, max } = MEASUREMENTS[key];
        if (EnergyMeterAbility.present(value) && value >= min && value <= max) {
            readings[key] = value;
        }
    }

    private assignPower(readings: Readings, value: number | null | undefined) {
        this.assign(readings, 'power', value);
        if (EnergyMeterAbility.present(value) && value >= MEASUREMENTS.power.min && value <= MEASUREMENTS.power.max) {
            // Eve's conventional consumption value is unsigned. Keep negative
            // net flow intact in the separate signed characteristic above.
            this.assign(readings, 'consumption', Math.max(0, value));
        }
    }

    private publish(service: Service | null | undefined, readings: Readings) {
        if (!service || this.stale) {
            return;
        }
        const cc = this.customCharacteristics;
        for (const key of Object.keys(MEASUREMENTS) as MeasurementName[]) {
            const value = readings[key];
            if (value === undefined) {
                // Clear stale values without substituting a fabricated zero.
                service
                    .getCharacteristic(cc[CHARACTERISTIC_KEYS[key]])
                    .updateValue(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY));
            } else {
                service.updateCharacteristic(cc[CHARACTERISTIC_KEYS[key]], value);
            }
        }
    }

    detach() {
        for (const { component, event } of this.listeners) {
            component.off(event, this.componentChangeHandler, this);
        }
        this.listeners.length = 0;
    }
}
