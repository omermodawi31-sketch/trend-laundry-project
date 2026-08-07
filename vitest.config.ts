import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    globals: false,
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/lib/migrate.ts", "src/config/logger.ts"],
    },
  },
});
