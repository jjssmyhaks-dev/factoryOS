import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts", "packages/*/src/**/index.ts"],
      thresholds: {
        "packages/domain/**": { lines: 80, functions: 80, branches: 75, statements: 80 },
        "packages/harness/**": { lines: 80, functions: 80, branches: 75, statements: 80 },
      },
    },
  },
});
