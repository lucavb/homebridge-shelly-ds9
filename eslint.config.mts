// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // Base recommended configs
    eslint.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.strict,

    // Global configuration
    {
        ignores: ['dist/**/*', 'node_modules/**/*'],
    },

    // TypeScript files configuration
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            ecmaVersion: 2018,
            sourceType: 'module',
        },
        rules: {
            // Logic and bug-catching rules (keeping from original config)
            'dot-notation': 'off',
            eqeqeq: 'warn',
            curly: ['warn', 'all'],
            'prefer-arrow-callback': ['warn'],
            'no-console': ['warn'],
            'no-multi-spaces': ['warn', { ignoreEOLComments: true }],

            // TypeScript-specific rules (keeping from original config)
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

            // Formatting rules are removed since Prettier will handle them:
            // - quotes, indent, semi, comma-dangle, brace-style, max-len
            // - comma-spacing, no-trailing-spaces, lines-between-class-members
            // - @typescript-eslint/semi, @typescript-eslint/member-delimiter-style
        },
    },

    // Test files configuration (more lenient)
    {
        files: ['**/*.spec.ts', '**/*.test.ts', '**/__tests__/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
);
