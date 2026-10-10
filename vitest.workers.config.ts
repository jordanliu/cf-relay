import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "tests/integration/wrangler.jsonc" },
    }),
  ],
  test: { include: ["tests/integration/**/*.test.ts"] },
});
