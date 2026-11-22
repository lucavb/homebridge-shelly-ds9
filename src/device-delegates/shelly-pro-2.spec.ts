import { describe, expect, it } from 'vitest';
import { ShellyPro2Rev2Ul } from '@lucavb/shellies-ds9';

import '../platform.ts';
import { DeviceDelegate } from './base.ts';
import { ShellyPro2Delegate } from './shelly-pro-2.ts';

describe('Shelly Pro 2 UL', () => {
    it('uses the Pro 2 delegate for the UL model', () => {
        expect(ShellyPro2Rev2Ul.model).toBe('SPSW-202XE12UL');
        expect(DeviceDelegate.getDelegate('SPSW-202XE12UL')).toBe(ShellyPro2Delegate);
    });
});
