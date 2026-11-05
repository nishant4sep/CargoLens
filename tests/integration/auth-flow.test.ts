/**
 * INTEGRATION — the auth flow behind the P4.1 UI (contract rows 1-3 and the
 * RSC session core). Runs via `npm run test:seed`; file order here is
 * api < auth-flow < seed-idempotency < upload, so afterAll must leave NO
 * trace: delete this suite's user (Session/Account cascade per schema),
 * then reseed pristine fixtures.
 *
 * Covered: valid login (signed cookie), wrong password vs unknown email
 * (SAME shape — no user-enumeration oracle), malformed body, /me with and
 * without cookie, tampered cookie, REAL session expiry (expiresAt forced to
 * the past), server-owned role visibility, logout (server-side revocation),
 * and getSessionUserFromHeaders (what the (app) layout guard calls).
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runSeed } from "@/server/seed/run";
import { SESSION_COOKIE, getSessionUserFromHeaders } from "@/server/http";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const EMAIL = "exec-auth@demo.cargolens.in";

let cookie = "";

function req(url: string, opts: { method?: string; body?: BodyInit; contentType?: string; cookie?: string } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    headers: {
      ...(opts.contentType ? { "content-type": opts.contentType } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
  });
}

async function login(email: string, password: string): Promise<{ status: number; setCookie: string; body: Record<string, unknown> }> {
  const res = await loginRoute.POST(
    req("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }), contentType: "application/json" }),
  );
  return { status: res.status, setCookie: res.headers.get("set-cookie") ?? "", body: await res.json() };
}

async function loginOk(email: string): Promise<string> {
  const { status, setCookie } = await login(email, PASSWORD);
  expect(status).toBe(200);
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
  if (!m) throw new Error("no session cookie on login response");
  return `${SESSION_COOKIE}=${m[1]}`;
}

beforeAll(async () => {
  await runSeed({ seedFlag: "true" });
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!existing) {
    await auth.api.signUpEmail({ body: { email: EMAIL, name: "Auth Flow Executive", password: PASSWORD } });
  }
  await prisma.user.update({ where: { email: EMAIL }, data: { role: "EXECUTIVE" } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } }); // sessions cascade
  await runSeed({ seedFlag: "true" }); // pristine fixtures for later files
});

describe("POST /api/auth/login (contract row 1)", () => {
  it("valid credentials → 200, {user:{id,name,role}}, SIGNED session cookie", async () => {
    const { status, setCookie, body } = await login(EMAIL, PASSWORD);
    expect(status).toBe(200);
    expect(body).toMatchObject({ user: { role: "EXECUTIVE" } });
    expect(body.user).not.toHaveProperty("email"); // response shape: no auth metadata
    const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(setCookie);
    expect(m).not.toBeNull();
    cookie = `${SESSION_COOKIE}=${m![1]}`;
    expect(m![1]).toContain("."); // signed `token.signature`, not a raw token
    expect(setCookie).toContain("HttpOnly");
  });

  it("wrong password → 401 UNAUTHENTICATED (envelope)", async () => {
    const { status, body } = await login(EMAIL, "definitely-wrong-password");
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: "UNAUTHENTICATED", message: "Invalid email or password" } });
  });

  it("unknown email → 401, IDENTICAL shape (no user-enumeration oracle)", async () => {
    const { status, body } = await login("nobody@demo.cargolens.in", PASSWORD);
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: "UNAUTHENTICATED", message: "Invalid email or password" } });
  });

  it("malformed body → 400 VALIDATION_ERROR (never 500)", async () => {
    const res = await loginRoute.POST(
      req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: 42 }), contentType: "application/json" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });
});

describe("GET /api/auth/me (contract row 3)", () => {
  it("with the session cookie → 200 flat {id, name, role}", async () => {
    const res = await meRoute.GET(req("/api/auth/me", { cookie }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Auth Flow Executive", role: "EXECUTIVE" });
  });

  it("without a cookie → 401", async () => {
    const res = await meRoute.GET(req("/api/auth/me"));
    expect(res.status).toBe(401);
  });

  it("TAMPERED cookie → 401 (signature check, library-enforced)", async () => {
    const tampered = cookie.slice(0, -3) + "xyz";
    const res = await meRoute.GET(req("/api/auth/me", { cookie: tampered }));
    expect(res.status).toBe(401);
  });

  it("REAL session expiry: expiresAt forced to the past → 401", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await meRoute.GET(req("/api/auth/me", { cookie }));
    expect(res.status).toBe(401);
  });
});

describe("role handling (server-owned field)", () => {
  it("role change is visible on the very next request — no caching", async () => {
    const fresh = await loginOk(EMAIL); // previous session expired above
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await prisma.user.update({ where: { id: user.id }, data: { role: "MANAGER" } });
    const res = await meRoute.GET(req("/api/auth/me", { cookie: fresh }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "MANAGER" });
    await prisma.user.update({ where: { id: user.id }, data: { role: "EXECUTIVE" } });
  });
});

describe("POST /api/auth/logout (contract row 2)", () => {
  it("destroys the session SERVER-side; the old cookie is dead afterwards", async () => {
    const fresh = await loginOk(EMAIL);
    const res = await logoutRoute.POST(req("/api/auth/logout", { method: "POST", cookie: fresh }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    const after = await meRoute.GET(req("/api/auth/me", { cookie: fresh }));
    expect(after.status).toBe(401); // revocation is real, not just cookie clearing
  });

  it("logout without a session → 401", async () => {
    const res = await logoutRoute.POST(req("/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(401);
  });
});

describe("getSessionUserFromHeaders — the (app) layout guard's core", () => {
  it("valid signed cookie → AuthUser with the DB role", async () => {
    const fresh = await loginOk(EMAIL);
    const h = new Headers({ cookie: fresh });
    const user = await getSessionUserFromHeaders(h);
    expect(user).not.toBeNull();
    expect(user!.email).toBe(EMAIL);
    expect(user!.role).toBe("EXECUTIVE");
  });

  it("garbage or missing cookie → null (the layout then redirects)", async () => {
    expect(await getSessionUserFromHeaders(new Headers({ cookie: `${SESSION_COOKIE}=nonsense` }))).toBeNull();
    expect(await getSessionUserFromHeaders(new Headers())).toBeNull();
  });
});
