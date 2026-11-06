/**
 * INTEGRATION — P4.5 approval + export workflow: rows 14–17 end-to-end against
 * the route handlers. The state machine stays the only gatekeeper:
 *   - executive approve → 403; unapproved export → 409 PREMATURE_EXPORT;
 *   - a BLOCKING FAIL names itself in the 409's missingCriteria;
 *   - approve → APPROVED (actor + timestamp + audit);
 *   - a post-approval write REVOKES (audit + cleared approval), clean data
 *     re-lifts to READY, re-approval succeeds;
 *   - export → 201 record (csvContent NEVER in the response), shipment
 *     EXPORTED, EXACT bytes re-downloadable (sha-verified), audit append-only.
 *
 * Mutations target ONLY shipments created here (never the seed's). Cleaned up
 * + reseeded in afterAll; storage redirected to a throwaway temp dir.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runSeed } from "@/server/seed/run";
import { SESSION_COOKIE } from "@/server/http";
import { CSV_FORMAT_VERSION, EXPORT_HEADER } from "@/server/engines/csv";
import { DEMO_SHIPMENTS, type DemoDocSpec } from "@/server/seed/fixtures";
import type { TypedFieldValue } from "@/lib/types";
import * as loginRoute from "@/app/api/auth/login/route";
import * as shipmentsRoute from "@/app/api/shipments/route";
import * as detailRoute from "@/app/api/shipments/[id]/route";
import * as uploadRoute from "@/app/api/shipments/[id]/documents/route";
import * as manualRoute from "@/app/api/documents/[id]/manual/route";
import * as patchFieldRoute from "@/app/api/shipments/[id]/fields/[fieldId]/route";
import * as auditRoute from "@/app/api/shipments/[id]/audit/route";
import * as approveRoute from "@/app/api/shipments/[id]/approve/route";
import * as exportRoute from "@/app/api/shipments/[id]/export/route";
import * as latestRoute from "@/app/api/shipments/[id]/export/latest/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const EXEC = "p45-exec@demo.cargolens.in";
const MANAGER = "p45-manager@demo.cargolens.in";
/** CSV-escaping fixture: comma + double quotes in a free-text supplier name. */
const CLEAN_SUPPLIER = 'P4.5 "Clean, Export" Co';

let cookie = ""; // executive
let managerCookie = "";
let storageDir = "";
let cleanId = ""; // SHP-24812 values → approve → revoke → re-approve → export
let mismatchId = ""; // SHP-24811 values → the blocking approve-409
const docIds: Record<string, Record<string, string>> = {};
const PDF = Buffer.from("%PDF-1.4\n% p4.5 approval/export test document\n");

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

/** Fixture typed values → ManualEntryDto raw strings (the inverse of parseCorrection). */
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

async function createShipmentWithDocs(supplierName: string, specRef: "SHP-24811" | "SHP-24812"): Promise<string> {
  const res = await shipmentsRoute.POST(
    req("/api/shipments", { method: "POST", body: JSON.stringify({ supplierName, supplierCountry: "CN" }), contentType: "application/json", cookie }),
  );
  expect(res.status).toBe(201);
  const id = ((await jsonOf(res)).shipment as { id: string; ref: string }).id;
  docIds[id] = {};
  for (const type of ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as const) {
    const form = new FormData();
    form.set("type", type);
    form.set("file", new File([new Uint8Array(PDF)], `${type.toLowerCase()}.pdf`, { type: "application/octet-stream" }));
    const up = await uploadRoute.POST(req(`/api/shipments/${id}/documents`, { method: "POST", body: form, cookie }), ctx({ id }));
    expect(up.status).toBe(201);
    const doc = await prisma.document.findUniqueOrThrow({ where: { shipmentId_type: { shipmentId: id, type } } });
    docIds[id][type] = doc.id;
    const spec = DEMO_SHIPMENTS.find((s) => s.ref === specRef)!;
    const docSpec = spec.docs.find((d) => d.type === type)!;
    const enter = await manualRoute.POST(
      req(`/api/documents/${doc.id}/manual`, { method: "POST", body: JSON.stringify(docToInput(docSpec)), contentType: "application/json", cookie }),
      ctx({ id: doc.id }),
    );
    expect(enter.status).toBe(200);
  }
  return id;
}

async function fieldId(shipment: string, type: "INVOICE", fieldKey: string): Promise<string> {
  const doc = await prisma.document.findUniqueOrThrow({ where: { shipmentId_type: { shipmentId: shipment, type } } });
  const field = await prisma.extractedField.findUniqueOrThrow({ where: { documentId_fieldKey: { documentId: doc.id, fieldKey } } });
  return field.id;
}

async function login(email: string, role: "EXECUTIVE" | "MANAGER"): Promise<string> {
  if (!(await prisma.user.findUnique({ where: { email } }))) {
    await auth.api.signUpEmail({ body: { email, name: email.startsWith("p45-manager") ? "P4.5 Manager" : "P4.5 Executive", password: PASSWORD } });
  }
  await prisma.user.update({ where: { email }, data: { role } });
  const res = await loginRoute.POST(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: PASSWORD }), contentType: "application/json" }));
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error(`login for ${email} produced no session cookie`);
  return `${SESSION_COOKIE}=${m[1]}`;
}

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "cargolens-p45-test-"));
  process.env.STORAGE_DIR = storageDir;
  await runSeed({ seedFlag: "true" });
  cookie = await login(EXEC, "EXECUTIVE");
  managerCookie = await login(MANAGER, "MANAGER");
  cleanId = await createShipmentWithDocs(CLEAN_SUPPLIER, "SHP-24812"); // → READY_FOR_APPROVAL
  mismatchId = await createShipmentWithDocs("P4.5 Mismatch Co", "SHP-24811"); // → NEEDS_REVIEW (blocking)
});

afterAll(async () => {
  rmSync(storageDir, { recursive: true, force: true });
  await prisma.shipment.deleteMany({ where: { id: { in: [cleanId, mismatchId].filter(Boolean) } } });
  await prisma.supplier.deleteMany({ where: { name: { in: [CLEAN_SUPPLIER, "P4.5 Mismatch Co"] } } });
  await prisma.user.deleteMany({ where: { email: { in: [EXEC, MANAGER] } } });
  await runSeed({ seedFlag: "true" }); // pristine fixtures for any later file
});

describe("authorization gates (rows 14 + 16)", () => {
  it("anonymous approve and export → 401", async () => {
    const a = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST" }), ctx({ id: cleanId }));
    expect(a.status).toBe(401);
    const e = await exportRoute.POST(req(`/api/shipments/${cleanId}/export`, { method: "POST" }), ctx({ id: cleanId }));
    expect(e.status).toBe(401);
  });

  it("executive cannot approve → 403 FORBIDDEN, and NO APPROVAL_GRANTED exists", async () => {
    const res = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect((body.error as { code: string; message: string }).code).toBe("FORBIDDEN");
    expect((body.error as { message: string }).message).toBe("Manager role required");
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "APPROVAL_GRANTED" } })).toBe(0);
  });

  it("export before approval → 409 PREMATURE_EXPORT, criteria name the status", async () => {
    const res = await exportRoute.POST(req(`/api/shipments/${cleanId}/export`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    const err = body.error as { code: string; message: string; details: { status: string } };
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("PREMATURE_EXPORT");
    expect(err.details.status).toBe("READY_FOR_APPROVAL");
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "EXPORT_GENERATED" } })).toBe(0);
  });

  it("manager approving a BLOCKING shipment → 409 naming GROSS_WEIGHT_CONSISTENCY", async () => {
    const res = await approveRoute.POST(req(`/api/shipments/${mismatchId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: mismatchId }));
    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    const err = body.error as { code: string; message: string; details: { status: string; unresolvedBlockingChecks: string[]; unclearedFieldCount: number } };
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("NOT_READY_FOR_APPROVAL");
    expect(err.details.status).toBe("NEEDS_REVIEW");
    expect(err.details.unresolvedBlockingChecks).toContain("GROSS_WEIGHT_CONSISTENCY");
    expect(err.details.unclearedFieldCount).toBe(0); // manual entry cleared everything — ONLY the check blocks
  });
});

describe("the approval lifecycle (row 14)", () => {
  it("manager approves the clean shipment → 200 APPROVED with actor + timestamp + audit", async () => {
    const res = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const s = body.shipment as { status: string; approvedAt: string | null };
    expect(s.status).toBe("APPROVED");
    expect(s.approvedAt).not.toBeNull();
    const manager = await prisma.user.findUniqueOrThrow({ where: { email: MANAGER } });
    const row = await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } });
    expect(row.approvedById).toBe(manager.id);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { shipmentId: cleanId, action: "APPROVAL_GRANTED" } });
    expect(audit.actorName).toBe("P4.5 Manager");
  });

  it("double approve → 409: the machine has no APPROVE from APPROVED; criteria name the state", async () => {
    const res = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    expect((body.error as { details: { status: string } }).details.status).toBe("APPROVED");
  });

  it("a field edit after approval REVOKES it: audit + cleared approval, clean data re-lifts to READY", async () => {
    const id = await fieldId(cleanId, "INVOICE", "incoterm");
    const res = await patchFieldRoute.PATCH(
      req(`/api/shipments/${cleanId}/fields/${id}`, { method: "PATCH", body: JSON.stringify({ value: "DAP" }), contentType: "application/json", cookie }),
      ctx({ id: cleanId, fieldId: id }),
    );
    expect(res.status).toBe(200);
    // Machine revokes (APPROVED → NEEDS_REVIEW), then the SAME-tx recompute of
    // fully-clean data lifts straight back to READY_FOR_APPROVAL — revocation
    // is observable in the cleared approval + the audit + required re-approval.
    expect((await jsonOf(res)).shipmentStatus).toBe("READY_FOR_APPROVAL");
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "APPROVAL_REVOKED" } })).toBe(1);
    const row = await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } });
    expect(row.approvedById).toBeNull();
    expect(row.approvedAt).toBeNull();

    const again = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(again.status).toBe(200); // the legitimate re-approval
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "APPROVAL_GRANTED" } })).toBe(2);
  });
});

describe("the gated export (rows 16–17)", () => {
  it("export → 201: exact record fields, csvContent NEVER in the response, shipment EXPORTED, audited", async () => {
    // Row 16 contract: the export route has NO role check — the enforcement is
    // the machine gate (APPROVED) + the live blocking re-check. An executive
    // cookie succeeding here is the CONTRACT, not a hole.
    const res = await exportRoute.POST(req(`/api/shipments/${cleanId}/export`, { method: "POST", body: undefined, cookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    const rec = body.exportRecord as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(["createdAt", "csvSha256", "fileName", "formatVersion", "id"]); // no csvContent
    expect(rec.fileName).toMatch(/-cargolens-csv-v1\.csv$/);
    expect(rec.formatVersion).toBe(CSV_FORMAT_VERSION);
    expect(rec.csvSha256).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } });
    expect(row.status).toBe("EXPORTED"); // SAME transaction as the record + audit
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "EXPORT_GENERATED" } })).toBe(1);
  });

  it("exporting again → 409: EXPORTED is terminal (no APPROVE, no EXPORT)", async () => {
    const res = await exportRoute.POST(req(`/api/shipments/${cleanId}/export`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(409);
    expect(((await jsonOf(res)).error as { message: string }).message).toContain("PREMATURE_EXPORT");
  });

  it("GET latest returns the EXACT recorded bytes: 23-col header, CRLF, escaping, exact numerics, sha headers", async () => {
    const before = await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "EXPORT_DOWNLOADED" } });
    const res = await latestRoute.GET(req(`/api/shipments/${cleanId}/export/latest`, { cookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("cargolens-csv-v1.csv");
    expect(res.headers.get("x-format-version")).toBe(CSV_FORMAT_VERSION);

    const text = await res.text();
    const sha = createHash("sha256").update(text).digest("hex");
    expect(res.headers.get("x-csv-sha256")).toBe(sha); // header matches the BYTES
    const rec = await prisma.exportRecord.findFirstOrThrow({ where: { shipmentId: cleanId }, orderBy: { createdAt: "desc" } });
    expect(rec.csvSha256).toBe(sha); // and the recorded hash — re-download is byte-true

    const lines = text.split("\r\n");
    expect(lines[lines.length - 1]).toBe(""); // final CRLF terminator
    expect(lines).toHaveLength(3); // header + 1 line item + terminator
    expect(lines[0].split(",")).toHaveLength(23);
    expect(lines[0]).toBe(EXPORT_HEADER.join(","));

    // The escaping fixture: comma + double quotes round-trip exactly (RFC 4180).
    expect(text).toContain('"P4.5 ""Clean, Export"" Co"');
    // Money/weights/counters: milli → real at the engine edge, bare numbers.
    // incoterm is "DAP" — the correction that revoked the first approval is
    // what ships, which is exactly the point of the revocation gate.
    for (const cell of ["INV-CC-1011", "2024-03-14", "EUR", "DAP", "7650", "1460", "6", "MSCU7654321", "MSCU9930011", "SESTO", "INNSA1", "MSC Baltic"]) {
      expect(text, `CSV must contain ${cell}`).toContain(cell);
    }
    expect(text).toContain(",180,pcs,42.5,7650"); // qty, unit, unit price, line total

    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "EXPORT_DOWNLOADED" } })).toBe(before + 1);
  });
});

describe("audit is append-only + nothing internal leaks", () => {
  it("POST /audit → 405: no route creates audit events from outside a business transaction", async () => {
    // The audit route exports ONLY GET — Next answers every other method with
    // 405 at the framework edge. The append-only guarantee is structural: a
    // POST export on this module would be a reviewable contract change.
    expect("POST" in auditRoute).toBe(false);
    expect("PATCH" in auditRoute).toBe(false);
    expect("DELETE" in auditRoute).toBe(false);
    expect("PUT" in auditRoute).toBe(false);
  });

  it("the detail aggregate leaks no storage internals, no CSV bodies, no secrets", async () => {
    const res = await detailRoute.GET(req(`/api/shipments/${cleanId}`, { cookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await jsonOf(res));
    expect(raw).not.toContain("storagePath");
    expect(raw).not.toContain("local://");
    expect(raw).not.toContain("csvContent"); // bytes only ever travel via row 17
    expect(raw).not.toContain(process.env.SEED_DEMO_PASSWORD ?? "cargolens-demo-password-123");
  });
});
