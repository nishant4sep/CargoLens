/**
 * INTEGRATION — Phase 5: the AI extraction path (contract row 9, file 05 §2).
 *
 * Runs against the TEST-ONLY stub provider (`EXTRACTION_PROVIDER=stub`, which
 * refuses to construct outside a test runtime) — deterministic, no network, no
 * secret. These tests prove the SERVICE PIPELINE (claiming, 503-before-state,
 * typed persistence, human-overwrite protection, failure outcomes, zombie
 * guard, unreadable→manual continuation, audit, recompute), NOT model quality:
 * live-provider evidence is a separate, explicitly labeled verification.
 *
 * Ground truth: the synthetic PDFs are GENERATED from the seed's own fixture
 * specs (SHP-24812 clean / SHP-24811 dirty), so persisted milli values are
 * asserted against the fixtures' exact numbers — a generator or normalizer bug
 * cannot fake a pass. File order follows the suite convention (manual-entry
 * template): own temp storage dir, own fixture shipment, full cleanup + reseed
 * in afterAll.
 */
import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runSeed } from "@/server/seed/run";
import { SESSION_COOKIE } from "@/server/http";
import { DEMO_SHIPMENTS, type DemoDocSpec } from "@/server/seed/fixtures";
import { syntheticDocPdf, syntheticNoisePdf, syntheticTrio, SYNTHETIC_SET } from "@/server/ai/synthetic-pdf";
import type { DocType, TypedFieldValue } from "@/lib/types";
import * as loginRoute from "@/app/api/auth/login/route";
import * as shipmentsRoute from "@/app/api/shipments/route";
import * as uploadRoute from "@/app/api/shipments/[id]/documents/route";
import * as extractRoute from "@/app/api/documents/[id]/extract/route";
import * as manualRoute from "@/app/api/documents/[id]/manual/route";
import * as fieldsRoute from "@/app/api/shipments/[id]/fields/[fieldId]/route";
import * as approveRoute from "@/app/api/shipments/[id]/approve/route";
import * as exportRoute from "@/app/api/shipments/[id]/export/route";

/** Failure injection: the mocked stub throws ProviderError while `fail` is set
 *  — proving FAILED is a HANDLED outcome, without touching the real network. */
const stubState = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/ai/stub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ai/stub")>();
  return {
    ...actual,
    getStubProvider: () => {
      const real = actual.getStubProvider();
      if (!stubState.fail) return real;
      return {
        name: real.name,
        extract: async () => {
          const { ProviderError } = await import("@/server/ai/provider");
          throw new ProviderError("simulated provider outage (test)");
        },
      };
    },
  };
});

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const MANAGER = "p5-manager@demo.cargolens.in";

let cookie = "";
let storageDir = "";
let savedKey: string | undefined;
let savedProvider: string | undefined;
let cleanId = ""; // SHP-24812 PDFs → the full ladder to READY_FOR_APPROVAL → APPROVED → EXPORTED
let verifyId = ""; // SHP-24811 PDFs + a noise BOL → failure/retry, zombie, unreadable→manual, CV-6
const docIds: Record<string, Record<string, string>> = { clean: {}, verify: {} };

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

async function uploadPdf(shipment: string, type: DocType, bytes: Buffer): Promise<void> {
  const form = new FormData();
  form.set("type", type);
  form.set("file", new File([new Uint8Array(bytes)], `${type.toLowerCase()}.pdf`, { type: "application/pdf" }));
  const res = await uploadRoute.POST(req(`/api/shipments/${shipment}/documents`, { method: "POST", body: form, cookie }), ctx({ id: shipment }));
  expect(res.status).toBe(201);
}

/** The Phase-5 action under test, through the REAL route. */
async function extractDoc(documentId: string) {
  return extractRoute.POST(req(`/api/documents/${documentId}/extract`, { method: "POST", cookie }), ctx({ id: documentId }));
}

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "cargolens-p5-test-"));
  process.env.STORAGE_DIR = storageDir;

  // Hermetic: this file ALWAYS runs the stub, even if .env later carries a real
  // key — no test may depend on (or spend) the live provider. Saved/restored in
  // afterAll.
  savedKey = process.env.GEMINI_API_KEY;
  savedProvider = process.env.EXTRACTION_PROVIDER;
  process.env.GEMINI_API_KEY = "";
  process.env.EXTRACTION_PROVIDER = "stub";

  await runSeed({ seedFlag: "true" });
  if (!(await prisma.user.findUnique({ where: { email: MANAGER } }))) {
    await auth.api.signUpEmail({ body: { email: MANAGER, name: "P5 Manager", password: PASSWORD } });
  }
  await prisma.user.update({ where: { email: MANAGER }, data: { role: "MANAGER" } });
  const login = await loginRoute.POST(
    req("/api/auth/login", { method: "POST", body: JSON.stringify({ email: MANAGER, password: PASSWORD }), contentType: "application/json" }),
  );
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(login.headers.get("set-cookie") ?? "");
  if (!m) throw new Error("p5 manager login produced no session cookie");
  cookie = `${SESSION_COOKIE}=${m[1]}`;

  // Two fresh shipments with REAL generated PDFs through the REAL upload route.
  const cleanSpec = SYNTHETIC_SET.clean;
  const dirtySpec = SYNTHETIC_SET.dirty;
  for (const [key, supplier, spec] of [
    ["clean", "P5 Extract Co", cleanSpec],
    ["verify", "P5 Verify Co", dirtySpec],
  ] as const) {
    const res = await shipmentsRoute.POST(
      req("/api/shipments", { method: "POST", body: JSON.stringify({ supplierName: supplier }), contentType: "application/json", cookie }),
    );
    expect(res.status).toBe(201);
    const id = ((await jsonOf(res)).shipment as { id: string }).id;
    if (key === "clean") cleanId = id;
    else verifyId = id;
    docIds[key] = {};
    for (const type of ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as const) {
      const bytes = key === "verify" && type === "BILL_OF_LADING" ? syntheticNoisePdf() : syntheticDocPdf(spec.docs.find((d) => d.type === type)!);
      await uploadPdf(id, type, bytes);
      const doc = await prisma.document.findUniqueOrThrow({ where: { shipmentId_type: { shipmentId: id, type } } });
      docIds[key][type] = doc.id;
    }
  }
});

afterAll(async () => {
  rmSync(storageDir, { recursive: true, force: true });
  await prisma.shipment.deleteMany({ where: { id: { in: [cleanId, verifyId].filter(Boolean) } } });
  await prisma.supplier.deleteMany({ where: { name: { in: ["P5 Extract Co", "P5 Verify Co"] } } });
  await prisma.user.deleteMany({ where: { email: MANAGER } });
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
  if (savedProvider === undefined) delete process.env.EXTRACTION_PROVIDER;
  else process.env.EXTRACTION_PROVIDER = savedProvider;
  await runSeed({ seedFlag: "true" }); // pristine fixtures for any later file
});

describe("P5: guards BEFORE any state change", () => {
  it("401 without a session; 404 for an unknown document", async () => {
    const unauth = await extractRoute.POST(req(`/api/documents/${docIds.clean.INVOICE}/extract`, { method: "POST" }), ctx({ id: docIds.clean.INVOICE }));
    expect(unauth.status).toBe(401);
    const missing = await extractRoute.POST(req("/api/documents/nope/extract", { method: "POST", cookie }), ctx({ id: "nope" }));
    expect(missing.status).toBe(404);
  });

  it("503 PROVIDER_UNAVAILABLE when no provider is configured — and NOTHING changes", async () => {
    delete process.env.EXTRACTION_PROVIDER; // GEMINI_API_KEY is "" in this file
    try {
      const res = await extractDoc(docIds.clean.INVOICE);
      expect(res.status).toBe(503);
      expect(await jsonOf(res)).toMatchObject({ error: { code: "PROVIDER_UNAVAILABLE" } });
      // the config check precedes every write: no claim, no audit, no status
      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: cleanId } })).status).toBe("DRAFT");
      expect((await prisma.document.findUniqueOrThrow({ where: { id: docIds.clean.INVOICE } })).status).toBe("UPLOADED");
      expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "EXTRACTION_STARTED" } })).toBe(0);
    } finally {
      process.env.EXTRACTION_PROVIDER = "stub";
    }
  });
});

describe("P5: the happy ladder on the clean fixture (SHP-24812)", () => {
  it("extracts the invoice into typed AI_DRAFT values with evidence and audits", async () => {
    const res = await extractDoc(docIds.clean.INVOICE);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.document).toMatchObject({ id: docIds.clean.INVOICE, status: "PROCESSED" });
    expect(body.shipmentStatus).toBe("PROCESSING"); // 1 of 3 documents terminal

    const extraction = body.extraction as { provider: string; fieldsWritten: string[]; documentUnreadable: boolean };
    expect(extraction.provider).toMatch(/stub/i); // the audit-visible name SELF-IDENTIFIES
    expect(extraction.documentUnreadable).toBe(false);
    expect(extraction.fieldsWritten.length).toBeGreaterThan(0);

    // THE ground-truth teeth: typed columns equal the FIXTURE milli values.
    const g = (fieldKey: string) =>
      prisma.extractedField.findUniqueOrThrow({ where: { documentId_fieldKey: { documentId: docIds.clean.INVOICE, fieldKey } } });
    const total = await g("totalValue");
    expect(total.valueNumeric?.toNumber()).toBe(7650);
    expect(total.currency).toBe("EUR"); // from the extraction's own currency field
    expect(total.status).toBe("AI_DRAFT");
    expect(total.confirmedById).toBeNull(); // AI rows are NEVER pre-confirmed
    expect(total.confidence?.toNumber()).toBe(0.99); // self-reported, from the fixture confidence map
    expect(total.sourcePage).toBe(1);
    expect(total.sourceExcerpt).toContain("Total Value"); // verbatim evidence
    expect((await g("invoiceNumber")).valueText).toBe("INV-CC-1011");
    expect((await g("invoiceDate")).valueDate?.toISOString().slice(0, 10)).toBe("2024-03-14");
    expect((await g("supplierName")).valueText).toBe("Company C (Sweden)");
    await expect(g("vesselName")).rejects.toThrow(); // absent on an invoice → NO row, never invented
    const lines = await prisma.lineItem.findMany({ where: { documentId: docIds.clean.INVOICE } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ seq: 1, description: "Steel ball valve DN50", hsnCode: "8481", unit: "pcs" });
    expect(lines[0]!.quantity.toNumber()).toBe(180);
    expect(lines[0]!.unitPrice!.toNumber()).toBe(42.5);
    expect(lines[0]!.lineTotal!.toNumber()).toBe(7650);

    // audits: an AI-claimed start, an AI-attributed completion
    const started = await prisma.auditEvent.findFirstOrThrow({ where: { shipmentId: cleanId, action: "EXTRACTION_STARTED" } });
    expect(started.payload).toMatchObject({ via: "AI" });
    const completed = await prisma.auditEvent.findFirstOrThrow({
      where: { shipmentId: cleanId, action: "EXTRACTION_COMPLETED", payload: { path: ["documentId"], equals: docIds.clean.INVOICE } },
    });
    expect(completed.payload).toMatchObject({ via: "AI", provider: extraction.provider });
  });

  it("partial completion: the shipment STAYS PROCESSING — no DOCS_REACHED_TERMINAL", async () => {
    const res = await extractDoc(docIds.clean.PACKING_LIST);
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).shipmentStatus).toBe("PROCESSING");
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "DOCS_REACHED_TERMINAL" } })).toBe(0);
  });

  it("last document completes the ladder: DOCS_REACHED_TERMINAL → recompute → NEEDS_REVIEW — AI drafts can NEVER approve", async () => {
    const res = await extractDoc(docIds.clean.BILL_OF_LADING);
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).shipmentStatus).toBe("NEEDS_REVIEW"); // zero blocking, but fields not human-cleared
    expect(await prisma.auditEvent.count({ where: { shipmentId: cleanId, action: "DOCS_REACHED_TERMINAL" } })).toBe(1);
    expect(await prisma.crossCheck.count({ where: { shipmentId: cleanId, result: "FAIL", severity: "BLOCKING", resolvedAt: null } })).toBe(0);
    expect(await prisma.crossCheck.count({ where: { shipmentId: cleanId } })).toBeGreaterThan(0); // engine actually ran
    // THE human-authority gate: unreviewed AI drafts must not reach approval.
    const attempt = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie }), ctx({ id: cleanId }));
    expect(attempt.status).toBe(409);
  });

  it("a human confirming every AI draft (the review step) lifts the SAME shipment to READY_FOR_APPROVAL", async () => {
    const drafts = await prisma.extractedField.findMany({ where: { shipmentId: cleanId, status: "AI_DRAFT" }, select: { id: true } });
    expect(drafts.length).toBeGreaterThan(0);
    let status = "";
    for (const f of drafts) {
      // PATCH without a value = CONFIRM the AI draft (row 12's confirm semantics)
      const res = await fieldsRoute.PATCH(
        req(`/api/shipments/${cleanId}/fields/${f.id}`, { method: "PATCH", body: JSON.stringify({}), contentType: "application/json", cookie }),
        ctx({ id: cleanId, fieldId: f.id }),
      );
      expect(res.status).toBe(200);
      status = (await jsonOf(res)).shipmentStatus as string;
    }
    expect(status).toBe("READY_FOR_APPROVAL"); // same data, now human-cleared
  });

  it("re-extract on READY re-opens the file (machine edge); CONFIRMED rows are skipped, not overwritten", async () => {
    const res = await extractDoc(docIds.clean.INVOICE);
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).shipmentStatus).toBe("READY_FOR_APPROVAL"); // READY→PROCESSING→…→READY
    const total = await prisma.extractedField.findUniqueOrThrow({
      where: { documentId_fieldKey: { documentId: docIds.clean.INVOICE, fieldKey: "totalValue" } },
    });
    expect(total.status).toBe("CONFIRMED"); // the human's confirm survived the re-run
    expect(total.valueNumeric?.toNumber()).toBe(7650);
    expect(total.confirmedById).not.toBeNull();
  });

  it("no regressions: READY approves, export gates hold, EXPORTED refuses extraction with 409", async () => {
    const ok = await approveRoute.POST(req(`/api/shipments/${cleanId}/approve`, { method: "POST", cookie }), ctx({ id: cleanId }));
    expect(ok.status).toBe(200);
    const exp = await exportRoute.POST(req(`/api/shipments/${cleanId}/export`, { method: "POST", cookie }), ctx({ id: cleanId }));
    expect(exp.status).toBe(201);
    const late = await extractDoc(docIds.clean.INVOICE);
    expect(late.status).toBe(409);
    expect(await jsonOf(late)).toMatchObject({ error: { code: "CONFLICT" } });
  });
});

describe("P5: failure, zombie, unreadable, and human protection (verify shipment)", () => {
  it("provider failure is a HANDLED outcome: FAILED + audited + retryable — never a 500, never a zombie", async () => {
    stubState.fail = true;
    try {
      const res = await extractDoc(docIds.verify.INVOICE);
      expect(res.status).toBe(200); // an outcome, not an error
      const body = await jsonOf(res);
      expect(body.document).toMatchObject({ status: "FAILED" });
      expect(body.extraction).toBeNull();
      expect(body.shipmentStatus).toBe("PROCESSING"); // 0 of 3 terminal → mid-phase
      expect((body.document as { extractError: string }).extractError).toMatch(/simulated provider outage/i);
      const failed = await prisma.auditEvent.findFirstOrThrow({ where: { shipmentId: verifyId, action: "EXTRACTION_FAILED" } });
      expect(failed.payload).toMatchObject({ via: "AI", provider: expect.stringMatching(/stub/i) });
    } finally {
      stubState.fail = false;
    }
    // RETRY: the same document extracts successfully afterwards.
    const retry = await extractDoc(docIds.verify.INVOICE);
    expect(retry.status).toBe(200);
    expect((await jsonOf(retry)).document).toMatchObject({ status: "PROCESSED" });
  });

  it("zombie guard: a FRESH PROCESSING run conflicts (409); a STALE one (>15 min) is re-runnable", async () => {
    await prisma.document.update({ where: { id: docIds.verify.INVOICE }, data: { status: "PROCESSING" } });
    const conflict = await extractDoc(docIds.verify.INVOICE);
    expect(conflict.status).toBe(409);
    expect(await jsonOf(conflict)).toMatchObject({ error: { code: "CONFLICT" } });
    // backdate beyond STALE_PROCESSING_MS — a crashed run must be recoverable
    await prisma.document.update({
      where: { id: docIds.verify.INVOICE },
      data: { status: "PROCESSING", updatedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });
    const recovered = await extractDoc(docIds.verify.INVOICE);
    expect(recovered.status).toBe(200);
    expect((await jsonOf(recovered)).document).toMatchObject({ status: "PROCESSED" });
  });

  it("UNREADABLE is terminal for the DOCUMENT but not the workflow: manual entry completes it", async () => {
    const res = await extractDoc(docIds.verify.BILL_OF_LADING); // the fixed-letter noise page
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.document).toMatchObject({ status: "UNREADABLE" });
    const extraction = body.extraction as { documentUnreadable: boolean };
    expect(extraction.documentUnreadable).toBe(true);
    const completed = await prisma.auditEvent.findFirstOrThrow({
      where: { shipmentId: verifyId, action: "EXTRACTION_COMPLETED", payload: { path: ["documentId"], equals: docIds.verify.BILL_OF_LADING } },
    });
    expect(completed.payload).toMatchObject({ documentUnreadable: true });
    expect(await prisma.auditEvent.count({ where: { shipmentId: verifyId, action: "DOCS_REACHED_TERMINAL" } })).toBe(0); // 2 of 3

    // the brief's own rule: manual entry proceeds on an unreadable document
    const bolSpec = SYNTHETIC_SET.dirty.docs.find((d) => d.type === "BILL_OF_LADING")!;
    const manual = await manualRoute.POST(
      req(`/api/documents/${docIds.verify.BILL_OF_LADING}/manual`, { method: "POST", body: JSON.stringify(docToInput(bolSpec)), contentType: "application/json", cookie }),
      ctx({ id: docIds.verify.BILL_OF_LADING }),
    );
    expect(manual.status).toBe(200);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: docIds.verify.BILL_OF_LADING } })).status).toBe("PROCESSED");
  });

  it("AI + manual mix completes the ladder, and the ENGINE grades AI values: CV-6 blocks on the planted 45 kg", async () => {
    const res = await extractDoc(docIds.verify.PACKING_LIST); // the last non-terminal document
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).shipmentStatus).toBe("NEEDS_REVIEW"); // dirty fixture ⇒ held in review
    const blocking = await prisma.crossCheck.findMany({ where: { shipmentId: verifyId, result: "FAIL", severity: "BLOCKING", resolvedAt: null } });
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.ruleKey).toBe("GROSS_WEIGHT_CONSISTENCY"); // invoice 3,120 vs PL 3,165 — read by AI, judged by the engine
    const attempt = await approveRoute.POST(req(`/api/shipments/${verifyId}/approve`, { method: "POST", cookie }), ctx({ id: verifyId }));
    expect(attempt.status).toBe(409); // the approval gate stands against AI-drafted data too
  });

  it("re-extraction REPLACES the AI layer wholesale: stale AI_DRAFT rows vanish, human rows survive", async () => {
    // arrange: a leftover draft from an "earlier run" with a key this invoice never shows
    await prisma.extractedField.create({
      data: {
        shipmentId: verifyId,
        documentId: docIds.verify.INVOICE,
        fieldKey: "vesselName", // an invoice does not print a vessel → the new run will not mention it
        status: "AI_DRAFT",
        valueText: "STALE VESSEL FROM EARLIER RUN",
      },
    });
    const res = await extractDoc(docIds.verify.INVOICE);
    expect(res.status).toBe(200);
    expect(
      await prisma.extractedField.findUnique({
        where: { documentId_fieldKey: { documentId: docIds.verify.INVOICE, fieldKey: "vesselName" } },
      }),
    ).toBeNull(); // replaced, not accumulated
    // …while the run's own rows were re-drafted, not duplicated
    expect(
      await prisma.extractedField.count({ where: { documentId: docIds.verify.INVOICE, status: "AI_DRAFT" } }),
    ).toBeGreaterThan(0);
  });

  it("human corrections SURVIVE re-extraction: skipped as human, byte-identical values", async () => {
    const shipmentField = await prisma.extractedField.findUniqueOrThrow({
      where: { documentId_fieldKey: { documentId: docIds.verify.INVOICE, fieldKey: "totalValue" } },
    });
    const patch = await fieldsRoute.PATCH(
      req(`/api/shipments/${verifyId}/fields/${shipmentField.id}`, { method: "PATCH", body: JSON.stringify({ value: "7,700.00" }), contentType: "application/json", cookie }),
      ctx({ id: verifyId, fieldId: shipmentField.id }),
    );
    expect(patch.status).toBe(200);
    const corrected = await prisma.extractedField.findUniqueOrThrow({
      where: { documentId_fieldKey: { documentId: docIds.verify.INVOICE, fieldKey: "totalValue" } },
    });
    expect(corrected.status).toBe("CORRECTED");
    expect(corrected.valueNumeric?.toNumber()).toBe(7700);
    expect(corrected.confirmedById).not.toBeNull();

    // re-extract: the human row is untouchable; everything else is re-drafted
    const res = await extractDoc(docIds.verify.INVOICE);
    expect(res.status).toBe(200);
    const extraction = (await jsonOf(res)).extraction as { fieldsSkippedHuman: string[]; fieldsWritten: string[] };
    expect(extraction.fieldsSkippedHuman).toContain("totalValue");
    expect(extraction.fieldsWritten).not.toContain("totalValue");
    const after = await prisma.extractedField.findUniqueOrThrow({
      where: { documentId_fieldKey: { documentId: docIds.verify.INVOICE, fieldKey: "totalValue" } },
    });
    expect(after.status).toBe("CORRECTED"); // untouched
    expect(after.valueNumeric?.toNumber()).toBe(7700);
    expect(after.confirmedById).toBe(corrected.confirmedById);
    // the AI layer AROUND it was re-drafted (invoiceNumber replaced wholesale)
    const sibling = await prisma.extractedField.findUniqueOrThrow({
      where: { documentId_fieldKey: { documentId: docIds.verify.INVOICE, fieldKey: "invoiceNumber" } },
    });
    expect(sibling.status).toBe("AI_DRAFT");
    expect(sibling.valueText).toBe("INV-CB-8841"); // dirty fixture ground truth
  });
});
