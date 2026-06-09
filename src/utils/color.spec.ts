import { describe, it, expect } from 'vitest';

import { hsvToRgb, rgbToHsv } from './color';

describe('color utils', () => {
    it('round-trips pure red', () => {
        const hsv = rgbToHsv(255, 0, 0);
        expect(hsv.h).toBeCloseTo(0, 0);
        expect(hsv.s).toBeCloseTo(100, 0);
        expect(hsv.v).toBeCloseTo(100, 0);

        const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
        expect(rgb.r).toBe(255);
        expect(rgb.g).toBe(0);
        expect(rgb.b).toBe(0);
    });

    it('round-trips mid-gray', () => {
        const hsv = rgbToHsv(128, 128, 128);
        expect(hsv.s).toBeCloseTo(0, 0);
        expect(hsv.v).toBeCloseTo(50.2, 0);

        const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
        expect(rgb.r).toBeCloseTo(128, 0);
        expect(rgb.g).toBeCloseTo(128, 0);
        expect(rgb.b).toBeCloseTo(128, 0);
    });

    it('round-trips green', () => {
        const hsv = rgbToHsv(0, 255, 0);
        expect(hsv.h).toBeCloseTo(120, 0);

        const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
        expect(rgb.r).toBe(0);
        expect(rgb.g).toBe(255);
        expect(rgb.b).toBe(0);
    });
});
