import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/contracts/**/*.test.ts", "tests/tooling/**/*.test.ts"],
    restoreMocks: true,
  },
});
