import { describe, it, expect } from 'vitest';
import { Categories } from 'homebridge';
import type { Cover, Device, Input, Light, Rgb, Rgbw, Switch } from '@lucavb/shellies-ds9';

import {
    AccessoryInformationAbility,
    CoverAbility,
    LightAbility,
    OutletAbility,
    PowerMeterAbility,
    RgbLightAbility,
    RgbwLightAbility,
    StatelessProgrammableSwitchAbility,
    SwitchAbility,
} from './abilities';
import { resolveAccessoryCategory } from './accessory';

const mockSwitch = { id: 0 } as Switch;
const mockLight = { id: 0 } as Light;
const mockRgb = { id: 0 } as Rgb;
const mockRgbw = { id: 0 } as Rgbw;
const mockCover = { id: 0 } as Cover;
const mockInput = { id: 0 } as Input;
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

    it('should return LIGHTBULB for an active RgbLightAbility', () => {
        const abilities = [new RgbLightAbility(mockRgb).setActive(true)];

        expect(resolveAccessoryCategory(abilities)).toBe(Categories.LIGHTBULB);
    });

    it('should return LIGHTBULB for an active RgbwLightAbility', () => {
        const abilities = [new RgbwLightAbility(mockRgbw).setActive(true)];

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
});
