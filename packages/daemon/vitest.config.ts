import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 2,
    // Integration cases start plugin processes and real shells on Windows.
    testTimeout: 60_000,
  },
});
