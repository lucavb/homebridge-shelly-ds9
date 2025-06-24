import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'], // Future-proof: Homebridge uses CJS today, but ESM tomorrow?
    dts: true,
    clean: true,
    sourcemap: true,
    minify: false,
    target: 'es2018',
    platform: 'node',
    outDir: 'dist',
    splitting: false,
    bundle: true,
    outExtension({ format }) {
        return {
            js: format === 'cjs' ? '.cjs' : '.mjs',
            dts: format === 'cjs' ? '.d.cts' : '.d.ts',
        };
    },
    treeshake: false,
    keepNames: true,
    cjsInterop: true,
});
