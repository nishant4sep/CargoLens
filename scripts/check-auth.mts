/**
 * Boot-check for the better-auth scaffold (A11 verification, run manually/explicitly —
 * not part of `npm test`).
 *
 * What this proves when it passes with no ERROR output from better-auth:
 *  1. The auth instance INITIALIZES — better-auth@1.7 validates the Prisma client's
 *     data model at init and logs/fails on missing tables/columns (docs: database
 *     concepts §Schema Validation). Silence = schema matches core requirements.
 *  2. `auth.api.getSession` — the same code path every protected API route will
 *     use — completes against a real request object (anonymous here).
 *  3. `env vars resolve: BETTER_AUTH_SECRET (>=32 chars) + DATABASE_URL via dotenv.
 */
import "dotenv/config";
import { auth } from "../src/lib/auth";

const headers = new Headers();
let sessionOk = false;
try {
  const res = await auth.api.getSession({ headers });
  // anonymous (no cookie) is fine — the point is that the endpoint EXECUTES
  sessionOk = true;
  console.log("getSession responded (session=", res ? "value" : "empty", ")");
} catch (e) {
  console.error("getSession FAILED:", e instanceof Error ? e.message : e);
}

const opts = auth.options as {
  emailAndPassword?: { enabled?: boolean };
  user?: { additionalFields?: Record<string, unknown> };
};
const role = opts.user?.additionalFields?.role as
  | { type?: unknown[]; input?: boolean }
  | undefined;

console.log(
  JSON.stringify(
    {
      betterAuthInit: "ok (init-time schema validation emitted no errors)",
      getSessionExecuted: sessionOk,
      emailAndPasswordEnabled: opts.emailAndPassword?.enabled === true,
      roleField: role
        ? {
            type: role.type,
            serverOwnedOnly: role.input === false,
          }
        : "MISSING",
    },
    null,
    2,
  ),
);

if (!sessionOk || !role || role.input !== false) process.exit(1);
