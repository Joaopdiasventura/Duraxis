import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./packages/storage/vitest.config.ts",
      "./packages/storage-memory/vitest.config.ts",
      "./packages/storage-disk/vitest.config.ts",
      "./packages/storage-s3/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/orm/vitest.config.ts",
      "./packages/nestjs/vitest.config.ts",
    ],

    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.spec.ts",
        "**/*.test.ts",
        "**/__tests__/**",
        "**/__test__/**",
        "packages/storage-testkit/**",
        "**/index.ts",
      ],
    },
  },
});
