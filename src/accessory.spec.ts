import { describe, it, expect } from 'vitest';
import { Categories } from 'homebridge';
import type { Cover, Device, Humidity, Input, Light, Switch, Temperature } from '@lucavb/shellies-ds9';

import {
    AccessoryInformationAbility,
    CoverAbility,
    HumiditySensorAbility,
    LightAbility,
    OutletAbility,
    PowerMeterAbility,
    StatelessProgrammableSwitchAbility,
    SwitchAbility,
    TemperatureSensorAbility,
} from './abilities/index.ts';
import { resolveAccessoryCategory } from './accessory.ts';

const mockSwitch = { id: 0 } as Switch;
const mockLight = { id: 0 } as Light;
const mockCover = { id: 0 } as Cover;
const mockInput = { id: 0 } as Input;
const mockTemperature = { id: 100 } as Temperature;
const mockHumidity = { id: 100 } as Humidity;
const mockDevice = { id: 'shellyplus1-abc123' } as Device;

describe('resolveAccessoryCategory()', () => {
    it('should return SWITCH for an active SwitchAbility', () => {
        const abilities = [
            new AccessoryInformationAbility(mockDevice).setActive(true),
            new SwitchAbility(mockSwitch).setActive(true),
        ];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.SWITCH);
    });

    it('should return OUTLET for an active OutletAbility with inactive SwitchAbility', () => {
        const abilities = [
            new OutletAbility(mockSwitch).setActive(true),
            new SwitchAbility(mockSwitch).setActive(false),
        ];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.OUTLET);
    });

    it('should return LIGHTBULB for an active LightAbility', () => {
        const abilities = [new LightAbility(mockLight).setActive(true)];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.LIGHTBULB);
    });

    it('should return DOOR for an active CoverAbility with type door', () => {
        const abilities = [new CoverAbility(mockCover, 'door').setActive(true)];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.DOOR);
    });

    it('should return WINDOW for an active CoverAbility with type window', () => {
        const abilities = [new CoverAbility(mockCover, 'window').setActive(true)];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.WINDOW);
    });

    it('should return WINDOW_COVERING for an active CoverAbility with type windowCovering', () => {
        const abilities = [new CoverAbility(mockCover, 'windowCovering').setActive(true)];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.WINDOW_COVERING);
    });

    it('should return OTHER when only PowerMeterAbility is active', () => {
        const abilities = [
            new AccessoryInformationAbility(mockDevice).setActive(true),
            new PowerMeterAbility(mockSwitch).setActive(true),
        ];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.OTHER);
    });

    it('should return PROGRAMMABLE_SWITCH for an active StatelessProgrammableSwitchAbility', () => {
        const abilities = [new StatelessProgrammableSwitchAbility(mockInput).setActive(true)];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.PROGRAMMABLE_SWITCH);
    });

    it('should return SENSOR for add-on temperature and humidity abilities', () => {
        const abilities = [
            new TemperatureSensorAbility(mockTemperature).setActive(true),
            new HumiditySensorAbility(mockHumidity).setActive(true),
        ];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.SENSOR);
    });
});
