/**
 * better-auth instance (ADR-02) — verified against better-auth@1.7.16 docs
 * (installation + prisma adapter + database concepts pages, fetched 2026-11-04).
 *
 * Decisions recorded here:
 *  - Database: Prisma adapter (the schema/tables are ours to migrate) over the
 *    built-in Kysely adapter (whose `auth migrate` could drift from Prisma's
 *    workflow during a 7-day build — one migration owner, period).
 *  - `role` is a SERVER-OWNED additional field (`input: false`): the API input
 *    can never grant roles; only server code writes them (seed/route logic).
 *    The DB keeps its own `Role` enum as the real integrity boundary.
 *  - emailAndPassword only, no social providers (brief: internal broker tool).
 *  - `advanced.database.joins` left OFF: performance knob, not correctness;
 *    revisit if the list screen shows N+1 session lookups.
 */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      role: {
        type: ["EXECUTIVE", "MANAGER"],
        defaultValue: "EXECUTIVE",
        required: false,
        input: false, // server-owned: never trusted from request bodies
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
