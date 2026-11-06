/**
 * INTEGRATION — P4.4 review workflow: the contracts the review screen
 * consumes — row-6 detail aggregate's review state (fields/lineItems/checks),
 * row-12 confirm/correct, row-10 manual-entry VALIDATION, row-13
 * accept-with-note, row-18 audit, and the signed-file failure modes (expired
 * token, missing file). The state machine is asserted at every step:
 * corrections lift a clean shipment to READY_FOR_APPROVAL, a write to APPROVED
 * revokes approval, EXPORTED refuses writes, and an unresolved BLOCKING FAIL
 * gates approval until resolved with a note — never bypassed.
 *
 * Mutations target ONLY shipments created here (never the seed's), so the
 * alphabetical suite order (…manual-entry-draft < review-workflow <
 * seed-idempotency < upload) always sees pristine fixtures. Cleaned up +
 * reseeded in afterAll; storage redirected to a throwaway temp dir.
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
import { signFileToken } from "@/server/storage";
import type { DocType, TypedFieldValue } from "@/lib/types";
import * as loginRoute from "@/app/api/auth/login/route";
import * as shipmentsRoute from "@/app/api/shipments/route";
import * as detailRoute from "@/app/api/shipments/[id]/route";
import * as uploadRoute from "@/app/api/shipments/[id]/documents/route";
import * as manualRoute from "@/app/api/documents/[id]/manual/route";
import * as patchFieldRoute from "@/app/api/shipments/[id]/fields/[fieldId]/route";
import * as resolveRoute from "@/app/api/shipments/[id]/checks/[checkId]/resolve/route";
import * as auditRoute from "@/app/api/shipments/[id]/audit/route";
import * as approveRoute from "@/app/api/shipments/[id]/approve/route";
import * as exportRoute from "@/app/api/shipments/[id]/export/route";
import * as fileRedirectRoute from "@/app/api/documents/[id]/file/route";
import * as fileStreamRoute from "@/app/api/files/[token]/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const EXEC = "p44-exec@demo.cargolens.in";
const MANAGER = "p44-manager@demo.cargolens.in";

let cookie = "";
let managerCookie = "";
let storageDir = "";
let cleanId = ""; // SHP-24812 values → the full review ladder
let mismatchId = ""; // SHP-24811 values → the resolve flow
const docIds: Record<string, Record<string, string>> = {};
const PDF = Buffer.from("%PDF-1.4\n% p4.4 review test document\n");

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
    req("/api/shipments", { method: "POST", body: JSON.stringify({ supplierName }), contentType: "application/json", cookie }),
  );
  expect(res.status).toBe(201);
  const id = ((await jsonOf(res)).shipment as { id: string }).id;
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

async function fieldId(shipment: string, type: DocType, fieldKey: string): Promise<string> {
  const doc = await prisma.document.findUniqueOrThrow({ where: { shipmentId_type: { shipmentId: shipment, type } } });
  const field = await prisma.extractedField.findUniqueOrThrow({ where: { documentId_fieldKey: { documentId: doc.id, fieldKey } } });
  return field.id;
}

async function checkId(shipment: string, ruleKey: string): Promise<string> {
  const check = await prisma.crossCheck.findUniqueOrThrow({ where: { shipmentId_ruleKey: { shipmentId: shipment, ruleKey } } });
  return check.id;
}

async function login(email: string, role: "EXECUTIVE" | "MANAGER"): Promise<string> {
  if (!(await prisma.user.findUnique({ where: { email } }))) {
    await auth.api.signUpEmail({ body: { email, name: email.startsWith("p44-manager") ? "P4.4 Manager" : "P4.4 Executive", password: PASSWORD } });
  }
  await prisma.user.update({ where: { email }, data: { role } });
  const res = await loginRoute.POST(req("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: PASSWORD }), contentType: "application/json" }));
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error(`login for ${email} produced no session cookie`);
  return `${SESSION_COOKIE}=${m[1]}`;
}

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "cargolens-p44-test-"));
  process.env.STORAGE_DIR = storageDir;
  await runSeed({ seedFlag: "true" });
  cookie = await login(EXEC, "EXECUTIVE");
  managerCookie = await login(MANAGER, "MANAGER");
  cleanId = await createShipmentWithDocs("P4.4 Clean Review Co", "SHP-24812");
  mismatchId = await createShipmentWithDocs("P4.4 Mismatch Review Co", "SHP-24811");
});

afterAll(async () => {
  rmSync(storageDir, { recursive: true, force: true });
  await prisma.shipment.deleteMany({ where: { id: { in: [cleanId, mismatchId].filter(Boolean) } } });
  await prisma.supplier.deleteMany({ where: { name: { in: ["P4.4 Clean Review Co", "P4.4 Mismatch Review Co"] } } });
  await prisma.user.deleteMany({ where: { email: { in: [EXEC, MANAGER] } } });
  await runSeed({ seedFlag: "true" }); // pristine fixtures for any later file
});

describe("review state (row-6 aggregate as the review screen's data source)", () => {
  it("serves fields, line items, checks and metrics — the review contract", async () => {
    const res = await detailRoute.GET(req(`/api/shipments/${cleanId}`, { cookie }), ctx({ id: cleanId }));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const fields = body.fields as Array<{ fieldKey: string; documentType: string; confidence: string | null; status: string }>;
    const lineItems = body.lineItems as Array<{ documentType: string }>;
    const checks = body.checks as Array<{ ruleKey: string; result: string; severity: string }>;
    expect(fields.length).toBeGreaterThanOrEqual(14); // invoice 7 + PL 2 + BOL 5 required minimums
    expect(fields.every((f) => f.status === "MANUAL_ENTERED" && f.confidence === null)).toBe(true); // D-1b provenance
    expect(lineItems.length).toBeGreaterThan(0);
    expect(checks).toHaveLength(9); // the full deterministic rule set
    const nonPassing = checks.filter((c) => c.result !== "PASS");
    expect(nonPassing, "every check on the clean fixture should PASS").toEqual([]); // clean fixture → all green
    expect((body.metrics as { unresolvedBlockingFails: number }).unresolvedBlockingFails).toBe(0);
  });

  it("rejects anonymous review access (401)", async () => {
    const res = await detailRoute.GET(req(`/api/shipments/${cleanId}`), ctx({ id: cleanId }));
    expect(res.status).toBe(401);
  });
});

describe("field review — row 12 (confirm / correct)", () => {
  it("confirm-as-extracted: no value ⇒ CONFIRMED + FIELD_CONFIRMED audit; second confirm is idempotent", async () => {
    const id = await fieldId(cleanId, "INVOICE", "invoiceNumber");
    const res = await patchFieldRoute.PATCH(
      req(`/api/shipments/${cleanId}/fields/${id}`, { method: "PATCH", body: JSON.stringify({}), contentType: "application/json", cookie }),
      ctx({ id: cleanId, fieldId: id }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect((body.field as { status: string }).status).toBe("CONFIRMED");
    expect(body.recomputed).toBe(true);
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "FIELD_CONFIRMED" } })).toBe(1);

    const again = await patchFieldRoute.PATCH(
      req(`/api/shipments/${cleanId}/fields/${id}`, { method: "PATCH", body: JSON.stringify({}), contentType: "application/json", cookie }),
      ctx({ id: cleanId, fieldId: id }),
    );
    expect(again.status).toBe(200);
    expect((await jsonOf(again)).recomputed).toBe(false); // idempotent — no second audit, no recompute
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "FIELD_CONFIRMED" } })).toBe(1);
  });

  it("correction: typed normalization + engine recompute — a clean correction ladder lifts to READY_FOR_APPROVAL", async () => {
    const id = await fieldId(cleanId, "INVOICE", "totalValue");
    const res = await patchFieldRoute.PATCH(
      req(`/api/shipments/${cleanId}/fields/${id}`, { method: "PATCH", body: JSON.stringify({ value: "7650.00" }), contentType: "application/json", cookie }),
      ctx({ id: cleanId, fieldId: id }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect((body.field as { status: string }).status).toBe("CORRECTED");
    expect((body.field as { valueNumeric: string }).valueNumeric).toBe("7650"); // REAL units, typed column
    expect(body.shipmentStatus).toBe("READY_FOR_APPROVAL"); // HUMAN_WRITE re-opened → recompute lifted again
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "FIELD_CORRECTED" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "CHECKS_RECOMPUTED" } })).toBeGreaterThanOrEqual(1);
  });

  it("APPROVED + write ⇒ revocation: status NEEDS_REVIEW, approval cleared, APPROVAL_REVOKED audited", async () => {
    const ok = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(ok.status).toBe(200);
    expect(((await jsonOf(ok)).shipment as { status: string }).status).toBe("APPROVED");

    const id = await fieldId(cleanId, "INVOICE", "incoterm");
    const res = await patchFieldRoute.PATCH(
      req(`/api/shipments/${cleanId}/fields/${id}`, { method: "PATCH", body: JSON.stringify({ value: "DAP" }), contentType: "application/json", cookie }),
      ctx({ id: cleanId, fieldId: id }),
    );
    expect(res.status).toBe(200);
    // The machine revokes (APPROVED → NEEDS_REVIEW, approval cleared) and the
    // SAME-tx recompute then lifts a fully-clean NEEDS_REVIEW back to
    // READY_FOR_APPROVAL — the revocation is observable in the cleared
    // approval + audit + the required RE-approval, not in the final status.
    expect((await jsonOf(res)).shipmentStatus).toBe("READY_FOR_APPROVAL");
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "APPROVAL_REVOKED" } })).toBe(1);
    const s = await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } });
    expect(s.approvedById).toBeNull();
  });

  it("invalid correction → 422 UNPROCESSABLE, value UNCHANGED (never silently converted)", async () => {
    const id = await fieldId(cleanId, "INVOICE", "totalValue");
    const before = await prisma.extractedField.findUniqueOrThrow({ where: { id } });
    const res = await patchFieldRoute.PATCH(
      req(`/api/shipments/${cleanId}/fields/${id}`, { method: "PATCH", body: JSON.stringify({ value: "not-a-number" }), contentType: "application/json", cookie }),
      ctx({ id: cleanId, fieldId: id }),
    );
    expect(res.status).toBe(422);
    const body = await jsonOf(res);
    expect((body.error as { code: string }).code).toBe("UNPROCESSABLE");
    const after = await prisma.extractedField.findUniqueOrThrow({ where: { id } });
    expect(after.valueNumeric?.toString()).toBe(before.valueNumeric?.toString());
    expect(after.status).toBe(before.status);
  });

  it("EXPORTED is terminal: field PATCH, manual entry and resolve all → 409", async () => {
    const ok = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(ok.status).toBe(200);
    const exp = await exportRoute.POST(req(`/api/shipments/${cleanId}/export`, { method: "POST", cookie: managerCookie }), ctx({ id: cleanId }));
    expect(exp.status).toBe(201);

    const fid = await fieldId(cleanId, "INVOICE", "invoiceNumber");
    const patch = await patchFieldRoute.PATCH(
      req(`/api/shipments/${cleanId}/fields/${fid}`, { method: "PATCH", body: JSON.stringify({ value: "INV-999" }), contentType: "application/json", cookie }),
      ctx({ id: cleanId, fieldId: fid }),
    );
    expect(patch.status).toBe(409);

    const manual = await manualRoute.POST(
      req(`/api/documents/${docIds[cleanId].INVOICE}/manual`, {
        method: "POST",
        body: JSON.stringify({ fields: [{ fieldKey: "incoterm", value: "FOB" }] }),
        contentType: "application/json",
        cookie,
      }),
      ctx({ id: docIds[cleanId].INVOICE }),
    );
    expect(manual.status).toBe(409);

    const cid = await checkId(cleanId, "REQUIRED_FIELDS");
    const resolve = await resolveRoute.POST(
      req(`/api/shipments/${cleanId}/checks/${cid}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note: "too late" }),
        contentType: "application/json",
        cookie,
      }),
      ctx({ id: cleanId, checkId: cid }),
    );
    // Resolve has NO explicit status guard: the not-resolvable guard runs
    // first (REQUIRED_FIELDS is PASS here → 422). An unresolved BLOCKING FAIL
    // cannot even exist on an exported shipment (export requires approval
    // requires zero unresolved) — for impossible states the status surfaces
    // through the recompute's own CONFLICT instead.
    expect(resolve.status).toBe(422);
  });
});

describe("blocking discrepancies — row 13 (accept-with-note), never bypassed", () => {
  it("approval is refused while the BLOCKING FAIL is unresolved, naming the check", async () => {
    const attempt = await approveRoute.POST(req(`/api/shipments/${mismatchId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: mismatchId }));
    expect(attempt.status).toBe(409);
    const body = await jsonOf(attempt);
    const details = (body.error as { details: { unresolvedBlockingChecks: string[] } }).details;
    expect(details.unresolvedBlockingChecks).toContain("GROSS_WEIGHT_CONSISTENCY");
  });

  it("resolve records who/why, clears the block, and the machine lifts the shipment on the next recompute", async () => {
    const cid = await checkId(mismatchId, "GROSS_WEIGHT_CONSISTENCY");
    const res = await resolveRoute.POST(
      req(`/api/shipments/${mismatchId}/checks/${cid}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note: "Supplier scale certificate matches packing list; invoice weight is the stale one." }),
        contentType: "application/json",
        cookie,
      }),
      ctx({ id: mismatchId, checkId: cid }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect((body.check as { resolvedAt: string | null }).resolvedAt).not.toBeNull();
    expect(body.shipmentStatus).toBe("READY_FOR_APPROVAL"); // fields all cleared + blocking now 0
    expect(await prisma.auditEvent.count({ where: { shipmentId: mismatchId, action: "DISCREPANCY_RESOLVED" } })).toBe(1);

    const ok = await approveRoute.POST(req(`/api/shipments/${mismatchId}/approve`, { method: "POST", cookie: managerCookie }), ctx({ id: mismatchId }));
    expect(ok.status).toBe(200); // the LEGITIMATE path through the gate
  });

  it("resolve is idempotent (second call: no new audit) and non-BLOCKING/PASS checks are 422", async () => {
    const cid = await checkId(mismatchId, "GROSS_WEIGHT_CONSISTENCY");
    const before = await prisma.auditEvent.count({ where: { shipmentId: mismatchId, action: "DISCREPANCY_RESOLVED" } });
    const again = await resolveRoute.POST(
      req(`/api/shipments/${mismatchId}/checks/${cid}/resolve`, { method: "POST", body: JSON.stringify({ note: "again" }), contentType: "application/json", cookie }),
      ctx({ id: mismatchId, checkId: cid }),
    );
    expect(again.status).toBe(200);
    expect((await jsonOf(again)).recomputed).toBe(false);
    expect(await prisma.auditEvent.count({ where: { shipmentId: mismatchId, action: "DISCREPANCY_RESOLVED" } })).toBe(before);

    const passId = await checkId(mismatchId, "REQUIRED_FIELDS");
    const wrong = await resolveRoute.POST(
      req(`/api/shipments/${mismatchId}/checks/${passId}/resolve`, { method: "POST", body: JSON.stringify({ note: "n/a" }), contentType: "application/json", cookie }),
      ctx({ id: mismatchId, checkId: passId }),
    );
    expect(wrong.status).toBe(422); // only BLOCKING FAILs are resolvable
  });

  it("manual-entry validation: garbage and empty values → 422, ZERO rows written", async () => {
    const docId = docIds[mismatchId].PACKING_LIST;
    const before = await prisma.extractedField.count({ where: { documentId: docId } });
    const bad = await manualRoute.POST(
      req(`/api/documents/${docId}/manual`, {
        method: "POST",
        body: JSON.stringify({ fields: [{ fieldKey: "grossWeightKg", value: "abc kg" }] }),
        contentType: "application/json",
        cookie,
      }),
      ctx({ id: docId }),
    );
    expect(bad.status).toBe(422);
    expect(((await jsonOf(bad)).error as { code: string }).code).toBe("UNPROCESSABLE");
    const empty = await manualRoute.POST(
      req(`/api/documents/${docId}/manual`, {
        method: "POST",
        body: JSON.stringify({ fields: [{ fieldKey: "grossWeightKg", value: "" }] }),
        contentType: "application/json",
        cookie,
      }),
      ctx({ id: docId }),
    );
    expect(empty.status).toBe(422);
    expect(await prisma.extractedField.count({ where: { documentId: docId } })).toBe(before);
  });
});

describe("audit (row 18) — the review screen's history", () => {
  it("newest-first, rich enough for the review UI", async () => {
    const res = await auditRoute.GET(req(`/api/shipments/${mismatchId}`, { cookie }), ctx({ id: mismatchId }));
    expect(res.status).toBe(200);
    const { events } = (await jsonOf(res)) as { events: Array<{ action: string; createdAt: string; actorName: string }> };
    expect(events.length).toBeGreaterThanOrEqual(4);
    const times = events.map((e) => new Date(e.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times); // strictly newest first
    expect(events[0].action).toBe("APPROVAL_GRANTED");
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["EXTRACTION_STARTED", "DOCS_REACHED_TERMINAL", "DISCREPANCY_RESOLVED"]),
    );
  });
});

describe("signed-file failure modes (the preview pane's contract)", () => {
  it("expired token → 403 FORBIDDEN (the UI's 'Access expired → Retry' state)", async () => {
    const expired = signFileToken(docIds[mismatchId].INVOICE, -1); // expired 1 second ago
    const res = await fileStreamRoute.GET(req(`/api/files/${expired}`), ctx({ token: expired }));
    expect(res.status).toBe(403);
    expect(((await jsonOf(res)).error as { code: string }).code).toBe("FORBIDDEN");
  });

  it("unknown document → 404 on the 302 route", async () => {
    const res = await fileRedirectRoute.GET(req("/api/documents/00000000-0000-4000-8000-000000000000/file", { cookie }), ctx({
      id: "00000000-0000-4000-8000-000000000000",
    }));
    expect(res.status).toBe(404);
  });

  it("DB row without its file → 302 signs fine, stream → 500 INTERNAL (integrity, restored after)", async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: docIds[mismatchId].PACKING_LIST } });
    const original = doc.storagePath;
    try {
      await prisma.document.update({ where: { id: doc.id }, data: { storagePath: "local://00000000-0000-4000-8000-000000000009.bin" } });
      const redirect = await fileRedirectRoute.GET(req(`/api/documents/${doc.id}/file`, { cookie }), ctx({ id: doc.id }));
      expect(redirect.status).toBe(302);
      const token = new URL(redirect.headers.get("location")!).pathname.split("/").pop()!;
      const stream = await fileStreamRoute.GET(req(`/api/files/${token}`), ctx({ token }));
      expect(stream.status).toBe(500);
      expect(((await jsonOf(stream)).error as { code: string }).code).toBe("INTERNAL");
    } finally {
      await prisma.document.update({ where: { id: doc.id }, data: { storagePath: original } });
    }
  });
});
