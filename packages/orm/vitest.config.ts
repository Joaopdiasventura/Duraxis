import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@duraxis/orm",
    environment: "node",
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
