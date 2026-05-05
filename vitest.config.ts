import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default include: unit tests are fast and always run.
    // Integration suites (bash / sandbox / install-test / windows / agent)
    // live in their own dirs and are run via dedicated npm scripts.
    include: ["tests/**/*.test.ts"],
    // Per-test default timeout. Integration tests may override.
    testTimeout: 10_000,
    hookTimeout: 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/bin/**"],
    },
    // Each test file gets its own worker for isolation.
    // Sessions create real PTYs; we don't want flaky cross-talk.
    pool: "forks",
  },
});
