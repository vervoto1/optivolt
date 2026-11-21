import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // HiGHS WASM solves in the lib tests can exceed the 5s default on slower CI
    // runners; give every test a generous ceiling so solver tests aren't flaky.
    testTimeout: 30000,
    hookTimeout: 30000,
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
      // Every line, branch, function and statement is covered; keep it that way.
      // Code that can never run is removed, or marked `v8 ignore next — <reason>`.
      thresholds: { 100: true },
    },
  },
});
