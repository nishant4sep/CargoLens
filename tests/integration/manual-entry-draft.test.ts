/**
 * INTEGRATION — D-1b: the manual-entry extraction path for fresh shipments
 * (approved Phase-4 plan). Until Phase-5 AI exists, manual entry IS the
 * extraction: DRAFT + first entry → machine's EXTRACTION_STARTED (→
 * PROCESSING), and when the LAST document reaches a terminal per-document
 * status → machine's DOCS_REACHED_TERMINAL (→ NEEDS_REVIEW), after which the
 * ordinary invariant recompute governs (clean ⇒ READY_FOR_APPROVAL). The
 * state machine TABLE is untouched — these tests prove the service fires the
 * machine's OWN events and that every gate (validation, approval) still
 * stands.
 *
 * Fixture values come from the seed's OWN demo specs (SHP-24812 = clean ⇒
 * full ladder to READY_FOR_APPROVAL; SHP-24811 = planted 45 kg discrepancy ⇒
 * stuck at NEEDS_REVIEW). File order: api < auth-flow < dashboard <
 * manual-entry-draft < seed-idempotency < upload — full cleanup + reseed in
 * afterAll, and storage goes to a throwaway temp dir like upload.test.ts.
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
import type { DocType, TypedFieldValue } from "@/lib/types";
import * as loginRoute from "@/app/api/auth/login/route";
import * as shipmentsRoute from "@/app/api/shipments/route";
import * as uploadRoute from "@/app/api/shipments/[id]/documents/route";
import * as manualRoute from "@/app/api/documents/[id]/manual/route";
import * as approveRoute from "@/app/api/shipments/[id]/approve/route";
import * as exportRoute from "@/app/api/shipments/[id]/export/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const MANAGER = "d1b-manager@demo.cargolens.in";

let cookie = "";
let storageDir = "";
let cleanId = ""; // SHP-24812 fixture values → full ladder to READY → APPROVED → EXPORTED
let mismatchId = ""; // SHP-24811 fixture values → NEEDS_REVIEW, approve 409
const docIds: Record<string, Record<string, string>> = { clean: {}, mismatch: {} };

const PDF = Buffer.from("%PDF-1.4\n% d1b test document\n");

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

const ctx = <P extends Record<string, string>>(params: P): { params: Promise<P> } => ({
  params: Promise.resolve(params),
});

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (res as { json: () => Promise<Record<string, unknown>> }).json();
}

/** Fixture typed values → ManualEntryDto raw strings (the inverse of parseCorrection). */
function typedToInput(v: TypedFieldValue): string {
  switch (v.kind) {
    case "TEXT":
    case "DATE":
      return v.value;
    case "MONEY":
      return (v.value / 1000).toFixed(2); // milli → decimal string
    case "COUNT":
      return String(v.value); // counts are real units, not milli
    case "WEIGHT_KG":
    case "QTY":
      return String(v.value / 1000); // milli → real
  }
}

function docToInput(spec: DemoDocSpec) {
  return {
    fields: Object.entries(spec.fields).map(([fieldKey, v]) => ({ fieldKey, value: typedToInput(v!) })),
    lineItems: spec.lineItems.map((li) => ({
      seq: li.seq,
      description: li.description,
      hsnCode: li.hsnCode,
      unit: li.unit,
      quantity: li.qtyMilli / 1000,
      unitPrice: li.unitPriceMilli / 1000,
    })),
  };
}

async function uploadDoc(shipment: string, type: DocType): Promise<void> {
  const form = new FormData();
  form.set("type", type);
  form.set("file", new File([new Uint8Array(PDF)], `${type.toLowerCase()}.pdf`, { type: "application/octet-stream" }));
  const res = await uploadRoute.POST(req(`/api/shipments/${shipment}/documents`, { method: "POST", body: form, cookie }), ctx({ id: shipment }));
  expect(res.status).toBe(201);
}

async function enterDoc(shipment: string, type: DocType, specRef: "SHP-24811" | "SHP-24812"): Promise<string> {
  const spec = DEMO_SHIPMENTS.find((s) => s.ref === specRef)!;
  const docSpec = spec.docs.find((d) => d.type === type)!;
  const documentId = docIds[shipment][type];
  const res = await manualRoute.POST(req(`/api/documents/${documentId}/manual`, { method: "POST", body: JSON.stringify(docToInput(docSpec)), contentType: "application/json", cookie }), ctx({ id: documentId }));
  return res.status.toString();
}

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "cargolens-d1b-test-"));
  process.env.STORAGE_DIR = storageDir;

  await runSeed({ seedFlag: "true" });
  if (!(await prisma.user.findUnique({ where: { email: MANAGER } }))) {
    await auth.api.signUpEmail({ body: { email: MANAGER, name: "D-1b Manager", password: PASSWORD } });
  }
  await prisma.user.update({ where: { email: MANAGER }, data: { role: "MANAGER" } });
  const login = await loginRoute.POST(
    req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: MANAGER, password: PASSWORD }), contentType: "application/json" }),
  );
  const raw = login.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(raw);
  if (!m) throw new Error("d1b manager login produced no session cookie");
  cookie = `${SESSION_COOKIE}=${m[1]}`;

  // two fresh DRAFT shipments through the real API, 3 uploads each
  for (const [key, supplier] of [["clean", "D-1b Clean Co"], ["mismatch", "D-1b Mismatch Co"]] as const) {
    const res = await shipmentsRoute.POST(
      req("/api/shipments", { method: "POST", body: JSON.stringify({ supplierName: supplier }), contentType: "application/json", cookie }),
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    const id = (body.shipment as { id: string }).id;
    if (key === "clean") cleanId = id;
    else mismatchId = id;
    docIds[id] = {};
    for (const type of ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as const) {
      await uploadDoc(id, type);
      const doc = await prisma.document.findUniqueOrThrow({ where: { shipmentId_type: { shipmentId: id, type } } });
      docIds[id][type] = doc.id;
    }
  }
});

afterAll(async () => {
  rmSync(storageDir, { recursive: true, force: true });
  await prisma.shipment.deleteMany({ where: { id: { in: [cleanId, mismatchId].filter(Boolean) } } });
  await prisma.supplier.deleteMany({ where: { name: { in: ["D-1b Clean Co", "D-1b Mismatch Co"] } } });
  await prisma.user.deleteMany({ where: { email: MANAGER } });
  await runSeed({ seedFlag: "true" }); // pristine fixtures for any later file
});

describe("D-1b: upload is storage, not extraction", () => {
  it("three uploads later the shipment is STILL DRAFT (no state event fires on upload)", async () => {
    for (const id of [cleanId, mismatchId]) {
      const s = await prisma.shipment.findUniqueOrThrow({ where: { id }, select: { status: true } });
      expect(s.status).toBe("DRAFT");
      expect(await prisma.document.count({ where: { shipmentId: id, status: "UPLOADED" } })).toBe(3);
    }
  });

  it("first manual entry on DRAFT fires EXTRACTION_STARTED (D-1b) and the document becomes PROCESSED with TYPED values", async () => {
    const status = await enterDoc(cleanId, "INVOICE", "SHP-24812");
    expect(status).toBe("200");

    const s = await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } });
    expect(s.status).toBe("PROCESSING");

    const started = await prisma.auditEvent.findFirstOrThrow({ where: { shipmentId: cleanId, action: "EXTRACTION_STARTED" } });
    expect(started.payload).toMatchObject({ via: "MANUAL_ENTRY" });

    const invoiceDoc = await prisma.document.findUniqueOrThrow({ where: { id: docIds[cleanId].INVOICE } });
    expect(invoiceDoc.status).toBe("PROCESSED");
    expect(invoiceDoc.extractedAt).not.toBeNull();

    // THE typing proof: money/date land in typed columns, not valueText dumps.
    const total = await prisma.extractedField.findUniqueOrThrow({ where: { documentId_fieldKey: { documentId: docIds[cleanId].INVOICE, fieldKey: "totalValue" } } });
    expect(total.valueNumeric?.toNumber()).toBe(7650);
    expect(total.status).toBe("MANUAL_ENTERED");
    expect(total.confidence).toBeNull(); // manual entry has no confidence
    const date = await prisma.extractedField.findUniqueOrThrow({ where: { documentId_fieldKey: { documentId: docIds[cleanId].INVOICE, fieldKey: "invoiceDate" } } });
    expect(date.valueDate?.toISOString().slice(0, 10)).toBe("2024-03-14");
  });

  it("partial terminal does NOT fire DOCS_REACHED_TERMINAL — shipment stays PROCESSING", async () => {
    const status = await enterDoc(cleanId, "PACKING_LIST", "SHP-24812");
    expect(status).toBe("200");
    const s = await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } });
    expect(s.status).toBe("PROCESSING");
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "DOCS_REACHED_TERMINAL" } })).toBe(0);
    const terminal = await prisma.document.count({ where: { shipmentId: cleanId, status: { in: ["PROCESSED", "UNREADABLE", "FAILED"] } } });
    expect(terminal).toBe(2);
  });

  it("LAST terminal document fires DOCS_REACHED_TERMINAL → NEEDS_REVIEW; clean invariants lift it to READY_FOR_APPROVAL", async () => {
    const status = await enterDoc(cleanId, "BILL_OF_LADING", "SHP-24812");
    expect(status).toBe("200");
    const s = await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } });
    expect(s.status).toBe("READY_FOR_APPROVAL"); // NEEDS_REVIEW was passed THROUGH, invariants recomputed clean
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "DOCS_REACHED_TERMINAL" } })).toBe(1);
    const blocking = await prisma.crossCheck.count({ where: { shipmentId: cleanId, result: "FAIL", severity: "BLOCKING", resolvedAt: null } });
    expect(blocking).toBe(0);
  });

  it("state-machine consistency: approval still gated — READY approves, EXPORTED refuses writes", async () => {
    const ok = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie }), ctx({ id: cleanId }));
    expect(ok.status).toBe(200);
    expect(((await jsonOf(ok)).shipment as { status: string }).status).toBe("APPROVED");

    const exp = await exportRoute.POST(req(`/api/shipments/${cleanId}/export`, { method: "POST", cookie }), ctx({ id: cleanId }));
    expect(exp.status).toBe(201);
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } }).then((s) => s.status)).toBe("EXPORTED");

    // EXPORTED is terminal — the manual-entry path cannot write either.
    const late = await manualRoute.POST(
      req(`/api/documents/${docIds[cleanId].INVOICE}/manual`, { method: "POST", body: JSON.stringify({ fields: [{ fieldKey: "incoterm", value: "DAP" }] }), contentType: "application/json", cookie }),
      ctx({ id: docIds[cleanId].INVOICE }),
    );
    expect(late.status).toBe(409);
    expect(await jsonOf(late)).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("mismatch data: D-1b reaches NEEDS_REVIEW and STAYS — no shortcut past validation or approval", async () => {
    for (const type of ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as const) {
      await enterDoc(mismatchId, type, "SHP-24811");
    }
    const s = await prisma.shipment.findUniqueOrThrow({ where: { id: mismatchId } });
    expect(s.status).toBe("NEEDS_REVIEW"); // DOCS_REACHED_TERMINAL fired…
    const blocking = await prisma.crossCheck.count({ where: { shipmentId: mismatchId, result: "FAIL", severity: "BLOCKING", resolvedAt: null } });
    expect(blocking).toBe(1); // …but CV-6 (45 kg) keeps it in review

    const attempt = await approveRoute.POST(req(`/api/shipments/${mismatchId}/approve`, { method: "POST", cookie }), ctx({ id: mismatchId }));
    expect(attempt.status).toBe(409);
    const body = await jsonOf(attempt);
    expect(body).toMatchObject({ error: { code: "CONFLICT" } });
    expect((body.error as { details: { unresolvedBlockingChecks: string[] } }).details.unresolvedBlockingChecks).toContain("GROSS_WEIGHT_CONSISTENCY");
  });
});
