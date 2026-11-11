import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@duraxis/nestjs",
    environment: "node",
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    clearMocks: true,
    restoreMocks: true,
    pool: "forks",
    maxWorkers: 1,
  },
});
