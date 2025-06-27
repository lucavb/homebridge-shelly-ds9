import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs'], // Keep it simple like your working plugin
    dts: true,
    clean: true,
    sourcemap: true,
    minify: false,
    target: 'es2018',
    platform: 'node',
    outDir: 'dist',
    splitting: false,
    bundle: true,
    external: ['homebridge'],
    treeshake: false,
    keepNames: true,
    cjsInterop: true,
});
