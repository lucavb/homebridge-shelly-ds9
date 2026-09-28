import { API } from 'homebridge';
import { join } from 'path';

/**
 * Resolves the file system path that is used for persistent data, such as the
 * device cache and fakegato history files.
 * Never throws; returns `undefined` if no path could be determined.
 * @param api - A reference to the homebridge API.
 */
export function resolveStoragePath(api: API): string | undefined {
    try {
        const dir = api.user.persistPath();
        if (typeof dir === 'string' && dir.length > 0) {
            return dir;
        }
    } catch {
        // fall through to the user storage path
    }

    try {
        const dir = api.user.storagePath();
        if (typeof dir === 'string' && dir.length > 0) {
            return join(dir, 'persist');
        }
        return undefined;
    } catch {
        return undefined;
    }
}
