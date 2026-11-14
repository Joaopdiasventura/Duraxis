import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@duraxis/storage-s3",
    environment: "node",
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
    fileParallelism: false,
  },
});
