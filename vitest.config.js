import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['api/**', 'lib/**', 'app/src/**'],
      exclude: [
        '**/node_modules/**',
        '**/AGENTS.md',
        '**/types.ts',
        'api/index.ts',
        'api/defaults/**',
      ],
    },
  },
});
