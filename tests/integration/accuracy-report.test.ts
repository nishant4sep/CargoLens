/**
 * INTEGRATION — P4.6 accuracy report (contract row 19): the endpoint the
 * accuracy page consumes. Asserts auth, validation, TRACEABILITY (the
 * response equals a direct DB group-by over the same rows — the page's every
 * number is provably a persisted aggregate), and that review actions move
 * the counts deterministically.
 *
 * Mutations target ONLY shipments created here (never the seed's). Cleaned
 * up + reseeded in afterAll.
 */
import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runSeed } from "@/server/seed/run";
import { SESSION_COOKIE } from "@/server/http";
import { DEMO_SHIPMENTS, type DemoDocSpec } from "@/server/seed/fixtures";
import type { TypedFieldValue } from "@/lib/types";
import * as loginRoute from "@/app/api/auth/login/route";
import * as accuracyRoute from "@/app/api/reports/accuracy/route";
import * as shipmentsRoute from "@/app/api/shipments/route";
import * as uploadRoute from "@/app/api/shipments/[id]/documents/route";
import * as manualRoute from "@/app/api/documents/[id]/manual/route";
import * as patchFieldRoute from "@/app/api/shipments/[id]/fields/[fieldId]/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const EXEC = "p46-exec@demo.cargolens.in";
const SUPPLIER = "P4.6 Accuracy Co";

let cookie = "";
let storageDir = "";
let shipmentId = "";
const docIds: Record<string, string> = {};
const PDF = Buffer.from("%PDF-1.4\n% p4.6 accuracy test document\n");

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

const ctx = <P extends Record<string, string>>(params: P): { params: Promise<P> } => ({ params: Promise.resolve(params) });

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (res as { json: () => Promise<Record<string, unknown>> }).json();
}

function typedToInput(v: TypedFieldValue): string {
  switch (v.kind) {
    case "TEXT":
    case "DATE":
      return v.value;
    case "MONEY":
      return (v.value / 1000).toFixed(2);
    case "COUNT":
      return String(v.value);
    case "WEIGHT_KG":
    case "QTY":
      return String(v.value / 1000);
  }
}

async function login(): Promise<string> {
  if (!(await prisma.user.findUnique({ where: { email: EXEC } }))) {
    await auth.api.signUpEmail({ body: { email: EXEC, name: "P4.6 Executive", password: PASSWORD } });
  }
  await prisma.user.update({ where: { email: EXEC }, data: { role: "EXECUTIVE" } });
  const res = await loginRoute.POST(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EXEC, password: PASSWORD }), contentType: "application/json" }));
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error("login produced no session cookie");
  return `${SESSION_COOKIE}=${m[1]}`;
}

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "cargolens-p46-test-"));
  process.env.STORAGE_DIR = storageDir;
  await runSeed({ seedFlag: "true" });
  cookie = await login();

  // Own fixture: clean spec via manual entry — fields land MANUAL_ENTERED.
  const res = await shipmentsRoute.POST(
    req("/api/shipments", { method: "POST", body: JSON.stringify({ supplierName: SUPPLIER }), contentType: "application/json", cookie }),
  );
  expect(res.status).toBe(201);
  shipmentId = ((await jsonOf(res)).shipment as { id: string }).id;
  const spec = DEMO_SHIPMENTS.find((s) => s.ref === "SHP-24812")!;
  for (const type of ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as const) {
    const form = new FormData();
    form.set("type", type);
    form.set("file", new File([new Uint8Array(PDF)], `${type.toLowerCase()}.pdf`, { type: "application/octet-stream" }));
    const up = await uploadRoute.POST(req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: form, cookie }), ctx({ id: shipmentId }));
    expect(up.status).toBe(201);
    const doc = await prisma.document.findUniqueOrThrow({ where: { shipmentId_type: { shipmentId: shipmentId, type } } });
    docIds[type] = doc.id;
    const docSpec = spec.docs.find((d) => d.type === type)!;
    const enter = await manualRoute.POST(
      req(`/api/documents/${doc.id}/manual`, {
        method: "POST",
        body: JSON.stringify({
          fields: Object.entries(docSpec.fields).map(([fieldKey, v]) => ({ fieldKey, value: typedToInput(v!) })),
          lineItems: docSpec.lineItems.map((li) => ({ seq: li.seq, description: li.description, hsnCode: li.hsnCode, unit: li.unit, quantity: li.qtyMilli / 1000, unitPrice: li.unitPriceMilli / 1000 })),
        }),
        contentType: "application/json",
        cookie,
      }),
      ctx({ id: doc.id }),
    );
    expect(enter.status).toBe(200);
  }
});

afterAll(async () => {
  rmSync(storageDir, { recursive: true, force: true });
  await prisma.shipment.deleteMany({ where: { id: shipmentId ? { in: [shipmentId] } : undefined } });
  await prisma.supplier.deleteMany({ where: { name: SUPPLIER } });
  await prisma.user.deleteMany({ where: { email: EXEC } });
  await runSeed({ seedFlag: "true" }); // pristine fixtures for any later file
});

describe("accuracy endpoint (row 19) — auth + validation", () => {
  it("anonymous → 401 (both group-bys)", async () => {
    const f = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=field"));
    expect(f.status).toBe(401);
    const s = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=supplier"));
    expect(s.status).toBe(401);
  });

  it("invalid groupBy → 400 VALIDATION_ERROR (no silent default on a typo)", async () => {
    const res = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=country", { cookie }));
    expect(res.status).toBe(400);
    expect(((await jsonOf(res)).error as { code: string }).code).toBe("VALIDATION_ERROR");
  });
});

describe("traceability — the response IS the DB aggregate", () => {
  it("byField rows equal a direct group-by over ExtractedField", async () => {
    const res = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=field", { cookie }));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const rows = body.rows as Array<{ fieldKey: string; total: number; confirmed: number; corrected: number; manualEntered: number; aiDraft: number }>;

    const db = await prisma.extractedField.groupBy({ by: ["fieldKey", "status"], _count: { _all: true } });
    const dbCount = (key: string, status?: string) =>
      db.filter((g) => g.fieldKey === key && (status === undefined || g.status === status)).reduce((n, g) => n + g._count._all, 0);

    // EVERY key in the DB appears exactly once in the response (no extra, no
    // missing) — the full cross-check, not a spot sample.
    const dbKeys = new Set(db.map((g) => g.fieldKey));
    for (const key of dbKeys) {
      const row = rows.find((r) => r.fieldKey === key);
      expect(row, `missing response row for ${key}`).toBeDefined();
      expect(row!.total).toBe(dbCount(key));
      expect(row!.aiDraft).toBe(dbCount(key, "AI_DRAFT"));
      expect(row!.manualEntered).toBe(dbCount(key, "MANUAL_ENTERED"));
      expect(row!.confirmed).toBe(dbCount(key) - dbCount(key, "AI_DRAFT")); // cleared = non-AI_DRAFT
    }
    expect(rows.length).toBe(dbKeys.size);
    // Conservation: the four statuses are disjoint and exhaustive, so per
    // field total = aiDraft + confirmed holds for every row, whatever the
    // world. (The seed ships fields as AI_DRAFT WITH confidence — simulated
    // extraction output awaiting review — so aiDraft > 0 is the HONEST demo
    // world, not a fabrication; the anti-fabrication rule is about derived
    // percentages, which these raw counts never are.)
    for (const r of rows) {
      expect(r.total).toBe(r.aiDraft + r.confirmed);
    }
  });

  it("bySupplier rows: my supplier's fields are counted AND human-cleared", async () => {
    const res = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=supplier", { cookie }));
    expect(res.status).toBe(200);
    const rows = ((await jsonOf(res)).rows as Array<{ supplierName: string | null; shipments: number; fieldsTotal: number; fieldsCleared: number }>);
    const mine = rows.find((r) => r.supplierName === SUPPLIER);
    expect(mine).toBeDefined();
    expect(mine!.shipments).toBe(1);
    expect(mine!.fieldsTotal).toBeGreaterThan(0);
    expect(mine!.fieldsCleared).toBe(mine!.fieldsTotal); // manual entry ⇒ fully cleared
  });

  it("review actions move the counts deterministically (correct → corrected +1)", async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { shipmentId_type: { shipmentId: shipmentId, type: "INVOICE" } } });
    const field = await prisma.extractedField.findUniqueOrThrow({ where: { documentId_fieldKey: { documentId: doc.id, fieldKey: "invoiceNumber" } } });
    const before = await prisma.extractedField.count({ where: { fieldKey: "invoiceNumber", status: "CORRECTED" } });

    const patch = await patchFieldRoute.PATCH(
      req(`/api/shipments/${shipmentId}/fields/${field.id}`, { method: "PATCH", body: JSON.stringify({ value: "INV-P46-CORRECTED" }), contentType: "application/json", cookie }),
      ctx({ id: shipmentId, fieldId: field.id }),
    );
    expect(patch.status).toBe(200);
    expect(((await jsonOf(patch)).field as { status: string }).status).toBe("CORRECTED");

    const res = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=field", { cookie }));
    const rows = ((await jsonOf(res)).rows as Array<{ fieldKey: string; corrected: number }>);
    expect(rows.find((r) => r.fieldKey === "invoiceNumber")!.corrected).toBe(before + 1);
  });
});
