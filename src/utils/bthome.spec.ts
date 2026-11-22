import { describe, expect, it } from 'vitest';
import { DynamicComponent } from '@lucavb/shellies-ds9';

import {
    getBTHomeSensorKind,
    getBTHomeLastUpdatedTimestamp,
    getKnownBTHomeButtonIndexes,
    groupBTHomeComponents,
    parseBTHomeAddress,
    parseBTHomeSensorConfig,
} from './bthome.ts';

function component(key: string, config: Record<string, unknown>): DynamicComponent {
    const parsed = { key, rpcName: key.split(':')[0]!, kind: 'unknown' as const, id: Number(key.split(':')[1]) };
    const result = new DynamicComponent({} as never, parsed);
    result.config = config;
    return result;
}

describe('BTHome utilities', () => {
    it('normalizes only complete BLE addresses', () => {
        expect(parseBTHomeAddress('3C:2E:F5:71:D5:2A')).toBe('3c:2e:f5:71:d5:2a');
        expect(parseBTHomeAddress('3c-2e-f5-71-d5-2a')).toBe('3c:2e:f5:71:d5:2a');
        expect(parseBTHomeAddress('unknown')).toBeUndefined();
        expect(parseBTHomeAddress('3c:2e:f5:71:d5')).toBeUndefined();
    });

    it('requires the complete sensor config tuple', () => {
        const valid = component('bthomesensor:201', { addr: '3c:2e:f5:71:d5:2a', obj_id: 2, idx: 1 });
        expect(parseBTHomeSensorConfig(valid)).toEqual({
            address: '3c:2e:f5:71:d5:2a',
            objectId: 2,
            index: 1,
        });
        expect(
            parseBTHomeSensorConfig(component('bthomesensor:202', { addr: 'invalid', obj_id: 2, idx: 0 })),
        ).toBeUndefined();
        expect(
            parseBTHomeSensorConfig(component('bthomesensor:203', { addr: '3c:2e:f5:71:d5:2a', obj_id: 2 })),
        ).toBeUndefined();
    });

    it('maps documented climate, contact, motion, and battery object IDs', () => {
        expect(getBTHomeSensorKind(1)).toBe('battery');
        expect(getBTHomeSensorKind(2)).toBe('temperature');
        expect(getBTHomeSensorKind(69)).toBe('temperature');
        expect(getBTHomeSensorKind(3)).toBe('humidity');
        expect(getBTHomeSensorKind(46)).toBe('humidity');
        expect(getBTHomeSensorKind(33)).toBe('motion');
        expect(getBTHomeSensorKind(45)).toBe('contact');
        expect(getBTHomeSensorKind(58)).toBeUndefined();
        expect(getBTHomeSensorKind(999)).toBeUndefined();
    });

    it('accepts either Shelly timestamp spelling but rejects malformed or conflicting values', () => {
        expect(getBTHomeLastUpdatedTimestamp({ last_update_ts: 1000 })).toBe(1000);
        expect(getBTHomeLastUpdatedTimestamp({ last_updated_ts: 1001 })).toBe(1001);
        expect(getBTHomeLastUpdatedTimestamp({ last_update_ts: 1002, last_updated_ts: 1002 })).toBe(1002);
        expect(getBTHomeLastUpdatedTimestamp({ last_update_ts: 1002, last_updated_ts: 1003 })).toBeNull();
        expect(getBTHomeLastUpdatedTimestamp({ last_update_ts: null })).toBeNull();
        expect(getBTHomeLastUpdatedTimestamp({})).toBeUndefined();
    });

    it('groups by physical address and preserves distinct object indexes', () => {
        const address = '3c:2e:f5:71:d5:2a';
        const device = component('bthomedevice:200', { addr: address });
        const temp0 = component('bthomesensor:201', { addr: address, obj_id: 2, idx: 0 });
        const temp1 = component('bthomesensor:202', { addr: address, obj_id: 2, idx: 1 });
        const duplicate = component('bthomesensor:203', { addr: address, obj_id: 2, idx: 1 });
        const grouped = groupBTHomeComponents([device, temp0, temp1, duplicate]);

        expect(grouped.size).toBe(1);
        expect(grouped.get(address)?.devices).toEqual([device]);
        expect(grouped.get(address)?.sensors.map(({ config }) => [config.objectId, config.index])).toEqual([
            [2, 0],
            [2, 1],
        ]);
    });

    it('preserves button indexes and treats malformed capability data as unknown', () => {
        expect(
            getKnownBTHomeButtonIndexes({
                objects: [
                    { obj_id: 58, idx: 0 },
                    { obj_id: 58, idx: 2 },
                ],
            }),
        ).toEqual([0, 2]);
        expect(getKnownBTHomeButtonIndexes({ objects: [{ obj_id: 1, idx: 0 }] })).toEqual([]);
        expect(getKnownBTHomeButtonIndexes({ objects: [{ obj_id: 58 }] })).toBeUndefined();
        expect(getKnownBTHomeButtonIndexes({ objects: [{ obj_id: '58', idx: 0 }] })).toBeUndefined();
        expect(getKnownBTHomeButtonIndexes(undefined)).toBeUndefined();
    });

    it('trims surrounding whitespace from BLE addresses before normalizing', () => {
        expect(parseBTHomeAddress('  3c:2e:f5:71:d5:2a  ')).toBe('3c:2e:f5:71:d5:2a');
        expect(parseBTHomeAddress('\t3C:2E:F5:71:D5:2A\n')).toBe('3c:2e:f5:71:d5:2a');
    });

    it('drops non-component entries and unmatched component keys while grouping', () => {
        const address = '3c:2e:f5:71:d5:2a';
        const device = component('bthomedevice:200', { addr: address });
        const temp = component('bthomesensor:201', { addr: address, obj_id: 2, idx: 0 });
        // Correctly shaped lookalikes that are not real DynamicComponent
        // instances must never be grouped.
        const impostor = {
            key: 'bthomesensor:999',
            config: { addr: address, obj_id: 2, idx: 0 },
        };
        // A component whose key matches neither the device nor sensor pattern
        // carries no BTHome data.
        const wrongKind = component('bthomeswitch:300', { addr: address, obj_id: 2, idx: 0 });

        const grouped = groupBTHomeComponents([impostor as never, wrongKind, device, temp]);

        expect(grouped.size).toBe(1);
        expect(grouped.get(address)?.devices).toEqual([device]);
        expect(grouped.get(address)?.sensors).toHaveLength(1);
        expect(grouped.get(address)?.sensors[0]?.component).toBe(temp);
    });

    it('rejects negative and fractional known button indexes', () => {
        expect(getKnownBTHomeButtonIndexes({ objects: [{ obj_id: 58, idx: -1 }] })).toBeUndefined();
        expect(getKnownBTHomeButtonIndexes({ objects: [{ obj_id: 58, idx: 1.5 }] })).toBeUndefined();
        expect(getKnownBTHomeButtonIndexes({ objects: [{ obj_id: 58, idx: NaN }] })).toBeUndefined();
        expect(getKnownBTHomeButtonIndexes({ objects: [{ obj_id: 58, idx: 0 }] })).toEqual([0]);
    });
});
