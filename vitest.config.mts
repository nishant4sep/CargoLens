import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest only covers the engine layer for now (Phase 3). Integration tests with a real
 * Postgres join the `include` list when the DB layer lands (file 06 §2.1).
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
