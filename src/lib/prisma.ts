/**
 * The ONE Prisma client instance for the whole app (services own it; route
 * handlers never construct their own — see isocode-preparation/04 §3).
 *
 * Prisma 7 twist (verified from better-auth's Prisma-7 guide + our own pin):
 * the client runs through a DRIVER ADAPTER (`@prisma/adapter-pg`) — the classic
 * binary engine path is gone. Dev-only secret note: DATABASE_URL is read from
 * process.env which Next inlines from .env; the CLI reads the same var via
 * prisma.config.ts.
 *
 * The `globalThis` cache is the documented Next.js dev pattern: hot reload
 * would otherwise construct a new pool per module re-evaluation and exhaust
 * Postgres connections.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  // Fail loudly (same philosophy as prisma.config.ts env()): an unset URL
  // should name its cause, not surface as a mysterious connection failure.
  throw new Error("DATABASE_URL is not set");
}

const createPrisma = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
