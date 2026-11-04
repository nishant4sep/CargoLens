import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest split: PURE suites here (engines, seed fixtures, guard) — no database
 * required, so `npm test` runs anywhere. DB-dependent tests live in
 * tests/integration/** (excluded below) and run via `npm run test:seed`
 * (vitest.integration.config.mts) — test isolation by suite (notebook 12).
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
    environment: "node",
  },
});
