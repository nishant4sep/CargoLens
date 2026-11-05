/**
 * INTEGRATION — the list contract the DASHBOARD consumes (row 4), including
 * the P4.2-additive `blockingFails` per item, checked against the seed's
 * known ground truth (SHP-24811 carries an unresolved BLOCKING CV-6 failure;
 * SHP-24812 is all-PASS). Read-only; afterAll just reseeds to be safe.
 * File order: api < dashboard < seed-idempotency < upload.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { runSeed } from "@/server/seed/run";
import { SESSION_COOKIE } from "@/server/http";
import * as loginRoute from "@/app/api/auth/login/route";
import * as shipmentsRoute from "@/app/api/shipments/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const MANAGER = "manager@demo.cargolens.in";

let cookie = "";

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    headers: cookie ? { cookie } : {},
  });
}

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (res as { json: () => Promise<Record<string, unknown>> }).json();
}

beforeAll(async () => {
  await runSeed({ seedFlag: "true" });
  const res = await loginRoute.POST(
    new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: MANAGER, password: PASSWORD }),
      headers: { "content-type": "application/json" },
    }),
  );
  const raw = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(raw);
  if (!m) throw new Error("manager login produced no session cookie");
  cookie = `${SESSION_COOKIE}=${m[1]}`;
});

afterAll(async () => {
  await runSeed({ seedFlag: "true" }); // read-only suite; reseed for order-independence
});

describe("GET /api/shipments — the dashboard's data source", () => {
  it("returns {items,page,total,hasMore} with the dashboard's exact columns", async () => {
    const res = await shipmentsRoute.GET(req("/api/shipments"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ page: 1, total: 2, hasMore: false });
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({
        ref: expect.any(String),
        status: expect.any(String),
        blockingFails: expect.any(Number),
        supplier: expect.anything(),
        _count: { documents: 3, checks: expect.any(Number) },
      });
    }
  });

  it("blockingFails matches seed ground truth: 24811 has 1 unresolved BLOCKING, 24812 has 0", async () => {
    const res = await shipmentsRoute.GET(req("/api/shipments"));
    const body = await jsonOf(res);
    const items = body.items as Array<{ ref: string; blockingFails: number }>;
    const byRef = new Map(items.map((i) => [i.ref, i.blockingFails]));
    expect(byRef.get("SHP-24811")).toBe(1);
    expect(byRef.get("SHP-24812")).toBe(0);
  });

  it("status filter narrows the list; q matches the reference", async () => {
    const byStatus = await shipmentsRoute.GET(req("/api/shipments?status=NEEDS_REVIEW"));
    const statusBody = await jsonOf(byStatus);
    // seed ground truth (psql, 2026-11-05): both demo shipments are NEEDS_REVIEW
    expect((statusBody.items as Array<{ ref: string }>).map((i) => i.ref)).toHaveLength(2);

    const byDraft = await shipmentsRoute.GET(req("/api/shipments?status=DRAFT"));
    expect(await jsonOf(byDraft)).toMatchObject({ items: [], total: 0 }); // the filtered empty state

    const byQ = await shipmentsRoute.GET(req("/api/shipments?q=24812"));
    const qBody = await jsonOf(byQ);
    expect((qBody.items as Array<{ ref: string }>).map((i) => i.ref)).toEqual(["SHP-24812"]);

    const noMatch = await shipmentsRoute.GET(req("/api/shipments?q=NOPE"));
    expect(await jsonOf(noMatch)).toMatchObject({ items: [], total: 0 }); // the dashboard's filtered empty state
  });
});
