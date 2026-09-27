import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { API } from 'homebridge';

import { resolveStoragePath } from './platform.ts';

describe('resolveStoragePath', () => {
    it('returns the homebridge persist path', () => {
        const api = {
            user: {
                persistPath: () => '/hb/persist',
                storagePath: () => '/hb',
            },
        } as unknown as API;

        expect(resolveStoragePath(api)).toBe('/hb/persist');
    });

    it('falls back to the persist directory under the user storage path', () => {
        const api = {
            user: {
                persistPath: () => {
                    throw new Error('persist path unavailable');
                },
                storagePath: () => '/hb',
            },
        } as unknown as API;

        expect(resolveStoragePath(api)).toBe(join('/hb', 'persist'));
    });

    it('ignores an empty persist path', () => {
        const api = {
            user: {
                persistPath: () => '',
                storagePath: () => '/hb',
            },
        } as unknown as API;

        expect(resolveStoragePath(api)).toBe(join('/hb', 'persist'));
    });

    it('returns undefined when the user storage path is empty', () => {
        const api = {
            user: {
                persistPath: () => '',
                storagePath: () => '',
            },
        } as unknown as API;

        expect(resolveStoragePath(api)).toBeUndefined();
    });

    it('returns undefined when both paths are unavailable', () => {
        const api = {
            user: {
                persistPath: () => {
                    throw new Error('persist path unavailable');
                },
                storagePath: () => {
                    throw new Error('storage path unavailable');
                },
            },
        } as unknown as API;

        expect(resolveStoragePath(api)).toBeUndefined();
    });
});
