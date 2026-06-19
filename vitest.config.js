import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    env: {
      TZ: 'Europe/Amsterdam',
    },
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['api/**', 'lib/**', 'app/src/**'],
      exclude: [
        '**/node_modules/**',
        '**/AGENTS.md',
        '**/types.ts',
        '**/*.http',
        'api/index.ts',
        'api/defaults/**',
        'tests/**',
      ],
    },
  },
});
