import { DynamicComponent } from '@lucavb/shellies-ds9';
import { Categories } from 'homebridge';

import { Ability, ServiceClass } from './base.ts';
import { parseBTHomeAddress } from '../utils/bthome.ts';

/**
 * Exposes button events reported by a BTHomeDevice. Only event names with an
 * exact HomeKit equivalent are forwarded; unsupported events are ignored.
 */
export class BTHomeButtonAbility extends Ability {
    private lifecycleGeneration = 0;

    constructor(
        readonly component: DynamicComponent,
        readonly index: number,
        readonly address: string,
    ) {
        super(`BTHome Button ${index + 1}`, `bthome-button-${index}`);
    }

    get category(): Categories {
        return Categories.PROGRAMMABLE_SWITCH;
    }

    protected get serviceClass(): ServiceClass {
        return this.Service.StatelessProgrammableSwitch;
    }

    protected initialize() {
        this.lifecycleGeneration++;
        this.service.setCharacteristic(this.Characteristic.ServiceLabelIndex, this.index + 1);
        this.component.on('event', this.eventHandler, this);
    }

    detach() {
        this.component.off('event', this.eventHandler, this);
        this.lifecycleGeneration++;
    }

    /** True only while ds9's retained key still identifies this BLE peripheral. */
    isCurrentComponentIdentity(): boolean {
        if (parseBTHomeAddress(this.component.config?.addr) !== this.address) {
            return false;
        }
        return this.component.device.getComponent(this.component.key) === this.component;
    }

    private eventHandler(event: unknown) {
        const generation = this.lifecycleGeneration;
        queueMicrotask(() => {
            if (generation !== this.lifecycleGeneration || !this.isCurrentComponentIdentity()) {
                return;
            }
            this.handleEvent(event);
        });
    }

    private handleEvent(event: unknown) {
        if (event === null || typeof event !== 'object' || Array.isArray(event)) {
            return;
        }

        const envelope = event as {
            component?: unknown;
            id?: unknown;
            event?: unknown;
            idx?: unknown;
            data?: unknown;
            ts?: unknown;
        };
        const componentId = Number(this.component.key.split(':')[1]);
        const nestedIndex =
            envelope.data !== null && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
                ? (envelope.data as { idx?: unknown }).idx
                : undefined;
        const index = envelope.idx ?? nestedIndex;
        // ds9's event dispatcher routes events either by the full component key
        // or by the base component name plus a numeric `id`.
        const matchesComponent =
            envelope.component === this.component.key ||
            (envelope.component === 'bthomedevice' && envelope.id === componentId);
        if (
            !matchesComponent ||
            (envelope.id !== undefined && envelope.id !== componentId) ||
            (envelope.idx !== undefined && nestedIndex !== undefined && envelope.idx !== nestedIndex) ||
            index !== this.index ||
            typeof envelope.ts !== 'number' ||
            !Number.isFinite(envelope.ts)
        ) {
            return;
        }

        const name = envelope.event;
        const programmableSwitchEvent = this.Characteristic.ProgrammableSwitchEvent;
        let value: number | undefined;
        switch (name) {
            case 'single_push':
                value = programmableSwitchEvent.SINGLE_PRESS;
                break;
            case 'double_push':
                value = programmableSwitchEvent.DOUBLE_PRESS;
                break;
            case 'long_push':
                value = programmableSwitchEvent.LONG_PRESS;
                break;
            default:
                return;
        }

        this.service.getCharacteristic(this.Characteristic.ProgrammableSwitchEvent).updateValue(value);
    }
}
