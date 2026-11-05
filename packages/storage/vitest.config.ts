import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@duraxis/storage",
    environment: "node",
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    clearMocks: true,
    restoreMocks: true,
  },
});
