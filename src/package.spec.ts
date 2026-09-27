import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
    main: string;
    types: string;
    exports: Record<string, Record<string, string | object>>;
};

describe('package.json exports', () => {
    // Homebridge's plugin loader (src/plugin.ts) unwraps package.json exports
    // by a single conditional level and assigns the chosen condition directly
    // to Plugin.main. Nested { types, default } objects make main an object
    // and crash path.join() with "TypeError: The path argument must be of
    // type string" — the plugin has failed to load for users since v1.8.0 (#25).
    it('keeps every exports condition a plain string path', () => {
        const dotExports: Record<string, string | object> = pkg.exports['.'];

        expect(dotExports, 'exports["."] must be an object').toBeTypeOf('object');
        const conditions = Object.entries(dotExports);
        expect(conditions.length, 'at least import/require conditions expected').toBeGreaterThanOrEqual(2);

        for (const [condition, value] of conditions) {
            expect(value, `exports["."].${condition} must be a plain string`).toBeTypeOf('string');
        }
    });

    it('points every entry point at a file the build produces', () => {
        const targets = [pkg.exports['.']?.['import'], pkg.exports['.']?.['require'], pkg.main, pkg.types];

        for (const target of targets) {
            expect(target, 'entry point must be defined').toBeTypeOf('string');
            expect(existsSync(resolve(pkgRoot, target as string)), `${target} not found — run npm run build`).toBe(
                true,
            );
        }
    });
});
