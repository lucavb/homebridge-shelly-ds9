import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateNotes } from '@semantic-release/release-notes-generator';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseConfig = JSON.parse(readFileSync(resolve(projectRoot, '.releaserc.json'), 'utf8')) as {
    plugins: [string, Record<string, unknown>][];
};
const generatorConfig = releaseConfig.plugins.find(
    ([pluginName]) => pluginName === '@semantic-release/release-notes-generator',
)?.[1];

describe('release notes generator configuration', () => {
    it('generates notes with the configured conventional commits preset and options', async () => {
        expect(generatorConfig).toBeDefined();

        const notes = await generateNotes(generatorConfig!, {
            commits: [
                { hash: 'a1b2c3d', message: 'feat(api): add export endpoint\n\nCloses #42' },
                { hash: 'd4e5f6a', message: 'fix: handle empty response' },
                { hash: 'b7c8d9e', message: 'chore: update generated metadata' },
            ],
            lastRelease: { gitTag: 'v1.6.1', gitHead: '0000000' },
            nextRelease: { version: '1.7.0', gitTag: 'v1.7.0', gitHead: 'a1b2c3d' },
            options: { repositoryUrl: 'https://github.com/lucavb/homebridge-shelly-ds9.git' },
            cwd: projectRoot,
        });

        expect(notes).toContain('### Features');
        expect(notes).toContain('**api:** add export endpoint');
        expect(notes).toContain('### Bug Fixes');
        expect(notes).toContain('handle empty response');
        expect(notes).toContain('closes [#42]');
        expect(notes).not.toContain('update generated metadata');
    });
});
