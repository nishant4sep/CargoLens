/**
 * Prisma 7 CLI configuration.
 *
 * Why this file exists: Prisma 7 moved the database connection URL out of
 * schema.prisma (P1012 — the datasource `url` property is no longer supported).
 * Only the provider stays in the schema; the URL is read from .env (git-ignored).
 *
 * `env()` (not `process.env!`) is deliberate: it throws a NAMED error if
 * DATABASE_URL is missing, instead of a confusing empty-connection failure —
 * the same fail-loudly philosophy as the seed guard.
 */
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

type Env = {
  DATABASE_URL: string;
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.mts",
  },
  datasource: {
    url: env<Env>("DATABASE_URL"),
  },
});
