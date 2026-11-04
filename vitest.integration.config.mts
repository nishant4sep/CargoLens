import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * INTEGRATION suite config — says explicitly what the unit config refuses:
 * DB-dependent tests against the live local dev Postgres (Docker container
 * cargolens-db, synthetic-only data per ADR-09). Runs via `npm run test:seed`.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // DB files share one Postgres — run files sequentially for determinism.
    fileParallelism: false,
  },
});
