/**
 * INTEGRATION — the API layer (contract rows 1–7, 10, 12–19) against the live
 * Docker Postgres. Runs via `npm run test:seed` (files are sequential —
 * fileParallelism false — DB files share one database).
 *
 * Chronology + hygiene:
 *  - beforeAll: ensure the demo fixtures exist (idempotent seed) + create the
 *    suite's OWN two users (API Executive / API Manager) so demo users are
 *    never actors of API-era mutations.
 *  - afterAll: delete ALL shipments + the suite's users, then re-seed —
 *    tests/integration/seed-idempotency.test.ts must always meet the
 *    PRISTINE fixture dataset (statuses AI_DRAFT, original values, fresh checks).
 *  - Negative cases (401/403/400/404/409/422) run interleaved with the flow,
 *    but the role test (executive → approve = 403) runs BEFORE the state
 *    machine could ever allow an approval.
 */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runSeed } from "@/server/seed/run";
import { SESSION_COOKIE } from "@/server/http";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as shipmentsRoute from "@/app/api/shipments/route";
import * as shipmentIdRoute from "@/app/api/shipments/[id]/route";
import * as fieldRoute from "@/app/api/shipments/[id]/fields/[fieldId]/route";
import * as resolveRoute from "@/app/api/shipments/[id]/checks/[checkId]/resolve/route";
import * as approveRoute from "@/app/api/shipments/[id]/approve/route";
import * as revokeRoute from "@/app/api/shipments/[id]/revoke/route";
import * as exportRoute from "@/app/api/shipments/[id]/export/route";
import * as exportLatestRoute from "@/app/api/shipments/[id]/export/latest/route";
import * as auditRoute from "@/app/api/shipments/[id]/audit/route";
import * as manualRoute from "@/app/api/documents/[id]/manual/route";
import * as accuracyRoute from "@/app/api/reports/accuracy/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const EXEC = "exec-api@demo.cargolens.in";
const MGR = "manager-api@demo.cargolens.in";

let execCookie = "";
let mgrCookie = "";

function req(url: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: opts.method ?? "GET",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    headers: {
      "content-type": "application/json",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
  });
}

const ctx = <P extends Record<string, string>>(params: P): { params: Promise<P> } => ({
  params: Promise.resolve(params),
});

async function loginAndGetCookie(email: string): Promise<string> {
  const res = await loginRoute.POST(
    req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }),
  );
  const raw = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(raw);
  if (!m) throw new Error(`login for ${email} produced no session cookie (status ${res.status})`);
  return `${SESSION_COOKIE}=${m[1]}`;
}

async function jsonOf(res: unknown): Promise<unknown> {
  // route handlers return NextResponse; json() is standard.
  return (res as { json: () => Promise<unknown> }).json();
}

async function fieldIdOf(ref: string, type: string, fieldKey: string): Promise<string> {
  const f = await prisma.extractedField.findFirstOrThrow({
    where: { shipment: { ref }, document: { type: type as "INVOICE" }, fieldKey },
    select: { id: true },
  });
  return f.id;
}

beforeAll(async () => {
  await runSeed({ seedFlag: "true" }); // idempotent ensure
  for (const u of [
    { email: EXEC, name: "API Executive", role: "EXECUTIVE" as const },
    { email: MGR, name: "API Manager", role: "MANAGER" as const },
  ]) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (!existing) {
      await auth.api.signUpEmail({ body: { email: u.email, name: u.name, password: PASSWORD } });
    }
    await prisma.user.update({ where: { email: u.email }, data: { role: u.role } });
  }
  execCookie = await loginAndGetCookie(EXEC);
  mgrCookie = await loginAndGetCookie(MGR);
});

afterAll(async () => {
  // Restore the pristine fixture dataset: everything the API suite touched is
  // deleted (cascades take fields/checks/audits/exports with it), the suite's
  // users go too, and find-then-create seeding rebuilds the canonical demo data.
  await prisma.shipment.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { in: [EXEC, MGR] } } });
  await runSeed({ seedFlag: "true" });
});

describe("authentication & the error envelope (rows 1–3)", () => {
  it("me without a session → 401 UNAUTHENTICATED envelope", async () => {
    const res = await meRoute.GET(req("/api/auth/me"));
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: { code: "UNAUTHENTICATED", message: expect.any(String) } });
  });

  it("login with bad credentials → 401 (library message, contract code)", async () => {
    const res = await loginRoute.POST(
      req("/api/auth/login", { method: "POST", body: { email: EXEC, password: "definitely-wrong-password" } }),
    );
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("me with a real session → {id, name, role} and NO email", async () => {
    const res = await meRoute.GET(req("/api/auth/me", { cookie: execCookie }));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ id: expect.any(String), name: "API Executive", role: "EXECUTIVE" });
  });
});

describe("authorization + validation negatives (server-side, always)", () => {
  it("list without a session → 401", async () => {
    expect((await shipmentsRoute.GET(req("/api/shipments"))).status).toBe(401);
  });

  it("field PATCH without a session → 401 (mutations re-check auth server-side)", async () => {
    const fieldId = await fieldIdOf("SHP-24811", "INVOICE", "totalValue");
    const res = await fieldRoute.PATCH(
      req(`/api/shipments/any/fields/${fieldId}`, { method: "PATCH", body: {} }),
      ctx({ id: "any", fieldId }),
    );
    expect(res.status).toBe(401);
  });

  it("executive calling approve → 403 FORBIDDEN (not UI-hidden — integration-proven)", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const res = await approveRoute.POST(req(`/api/shipments/${s.id}/approve`, { method: "POST", cookie: execCookie }), ctx({ id: s.id }));
    expect(res.status).toBe(403);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("bad query (page=0) → 400 VALIDATION_ERROR", async () => {
    const res = await shipmentsRoute.GET(req("/api/shipments?page=0", { cookie: execCookie }));
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("bad create body (unknown key, strict DTO) → 400", async () => {
    const res = await shipmentsRoute.POST(
      req("/api/shipments", { method: "POST", body: { supplierName: "X", hacker: true }, cookie: execCookie }),
    );
    expect(res.status).toBe(400);
  });

  it("unknown shipment id → 404", async () => {
    const res = await shipmentIdRoute.GET(
      req("/api/shipments/00000000-0000-4000-8000-000000000000", { cookie: execCookie }),
      ctx({ id: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("list + create + detail (rows 4–7)", () => {
  it("list is paginated and contains the seeded fixtures", async () => {
    const res = await shipmentsRoute.GET(req("/api/shipments", { cookie: execCookie }));
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { items: { ref: string }[]; page: number; hasMore: boolean };
    expect(body.page).toBe(1);
    expect(body.items.map((i) => i.ref)).toEqual(expect.arrayContaining(["SHP-24811", "SHP-24812"]));
  });

  it("create → 201, DRAFT, ref SHP-YYYYMM-NN, SHIPMENT_CREATED audited", async () => {
    const res = await shipmentsRoute.POST(
      req("/api/shipments", { method: "POST", body: { supplierName: "Company B (China)" }, cookie: execCookie }),
    );
    expect(res.status).toBe(201);
    const { shipment } = (await jsonOf(res)) as { shipment: { id: string; ref: string; status: string } };
    expect(shipment.status).toBe("DRAFT");
    expect(shipment.ref).toMatch(/^SHP-\d{6}-\d{2,}$/);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { shipmentId: shipment.id, action: "SHIPMENT_CREATED" },
    });
    expect(audit.actorName).toBe("API Executive");
  });

  it("detail aggregate: SHP-24811 → 3 documents, 9 checks, metrics present", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const res = await shipmentIdRoute.GET(req(`/api/shipments/${s.id}`, { cookie: execCookie }), ctx({ id: s.id }));
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as {
      shipment: { ref: string; status: string };
      documents: unknown[];
      checks: unknown[];
      metrics: { documentsCount: number; unresolvedBlockingFails: number };
    };
    expect(body.shipment.ref).toBe("SHP-24811");
    expect(body.documents).toHaveLength(3);
    expect(body.checks).toHaveLength(9);
    expect(body.metrics.unresolvedBlockingFails).toBe(1); // the pristine fixture's CV-6 FAIL
  });
});

describe("review workflow on SHP-24811 (rows 12, 13, 10)", () => {
  it("confirm (no value) → CONFIRMED, audited ONCE even when confirmed twice", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const fieldId = await fieldIdOf("SHP-24811", "INVOICE", "totalValue");
    const res = await fieldRoute.PATCH(
      req(`/api/shipments/${s.id}/fields/${fieldId}`, { method: "PATCH", body: {}, cookie: execCookie }),
      ctx({ id: s.id, fieldId }),
    );
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { field: { status: string }; recomputed: boolean };
    expect(body.field.status).toBe("CONFIRMED");
    expect(body.recomputed).toBe(true);

    const before = await prisma.auditEvent.count({
      where: { shipment: { ref: "SHP-24811" }, action: "FIELD_CONFIRMED" },
    });
    await fieldRoute.PATCH(
      req(`/api/shipments/${s.id}/fields/${fieldId}`, { method: "PATCH", body: {}, cookie: execCookie }),
      ctx({ id: s.id, fieldId }),
    );
    const after = await prisma.auditEvent.count({
      where: { shipment: { ref: "SHP-24811" }, action: "FIELD_CONFIRMED" },
    });
    expect(after).toBe(before); // idempotent: harmless + audited once (file 04 row-12 note)
  });

  it("resolve-with-note on the CV-6 FAIL → resolution recorded, DISCREPANCY_RESOLVED audited", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const cv6 = await prisma.crossCheck.findUniqueOrThrow({
      where: { shipmentId_ruleKey: { shipmentId: s.id, ruleKey: "GROSS_WEIGHT_CONSISTENCY" } },
    });
    const res = await resolveRoute.POST(
      req(`/api/shipments/${s.id}/checks/${cv6.id}/resolve`, {
        method: "POST",
        body: { note: "Supplier letter confirms 3,120 kg; BOL typo acknowledged" },
        cookie: execCookie,
      }),
      ctx({ id: s.id, checkId: cv6.id }),
    );
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { check: { resolvedNote: string | null } };
    expect(body.check.resolvedNote).toContain("3,120 kg");
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { shipmentId: s.id, action: "DISCREPANCY_RESOLVED" },
    });
    expect(audit.actorId).toBeTruthy();
  });

  it("resolving a PASS/WARNING check → 422", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24812" } });
    const passing = await prisma.crossCheck.findFirstOrThrow({
      where: { shipmentId: s.id, result: "PASS" },
    });
    const res = await resolveRoute.POST(
      req(`/api/shipments/${s.id}/checks/${passing.id}/resolve`, {
        method: "POST",
        body: { note: "n/a" },
        cookie: execCookie,
      }),
      ctx({ id: s.id, checkId: passing.id }),
    );
    expect(res.status).toBe(422);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "UNPROCESSABLE" } });
  });

  it("correction parses by kind: PL weight 3120 → CORRECTED + FIELD_CORRECTED audit; BOL follows → CV-6 PASS", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const plWeightId = await fieldIdOf("SHP-24811", "PACKING_LIST", "grossWeightKg");
    const res = await fieldRoute.PATCH(
      req(`/api/shipments/${s.id}/fields/${plWeightId}`, { method: "PATCH", body: { value: "3120" }, cookie: execCookie }),
      ctx({ id: s.id, fieldId: plWeightId }),
    );
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { field: { status: string; valueNumeric: string } };
    expect(body.field.status).toBe("CORRECTED");
    expect(Number(body.field.valueNumeric)).toBe(3120);
    // the "from" value in the audit payload is the extracted 3165
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { shipment: { ref: "SHP-24811" }, action: "FIELD_CORRECTED", payload: { path: ["fieldId"], equals: plWeightId } },
    });
    expect(audit.payload).toMatchObject({ from: "3165", to: "3120" });

    // BOL still says 3165 → CV-6 must still FAIL (now invoice+PL vs BOL)
    const cv6 = await prisma.crossCheck.findUniqueOrThrow({
      where: { shipmentId_ruleKey: { shipmentId: s.id, ruleKey: "GROSS_WEIGHT_CONSISTENCY" } },
    });
    expect(cv6.result).toBe("FAIL");

    const bolWeightId = await fieldIdOf("SHP-24811", "BILL_OF_LADING", "grossWeightKg");
    await fieldRoute.PATCH(
      req(`/api/shipments/${s.id}/fields/${bolWeightId}`, { method: "PATCH", body: { value: "3120" }, cookie: execCookie }),
      ctx({ id: s.id, fieldId: bolWeightId }),
    );
    const cv6After = await prisma.crossCheck.findUniqueOrThrow({
      where: { shipmentId_ruleKey: { shipmentId: s.id, ruleKey: "GROSS_WEIGHT_CONSISTENCY" } },
    });
    expect(cv6After.result).toBe("PASS"); // recomputed; PASS also cleared the stale resolution
    expect(cv6After.resolvedNote).toBeNull();
  });

  it("manual entry → MANUAL_ENTERED with confidence NULL + MANUAL_ENTRY audit", async () => {
    const bol = await prisma.document.findFirstOrThrow({
      where: { shipment: { ref: "SHP-24811" }, type: "BILL_OF_LADING" },
    });
    const res = await manualRoute.POST(
      req(`/api/documents/${bol.id}/manual`, {
        method: "POST",
        body: { fields: [{ fieldKey: "consigneeAddress", value: "Plot 5, JNPT, Navi Mumbai" }] },
        cookie: execCookie,
      }),
      ctx({ id: bol.id }),
    );
    expect(res.status).toBe(200);
    const f = await prisma.extractedField.findUniqueOrThrow({
      where: { documentId_fieldKey: { documentId: bol.id, fieldKey: "consigneeAddress" } },
    });
    expect(f.status).toBe("MANUAL_ENTERED");
    expect(f.confidence).toBeNull();
    expect(f.valueText).toBe("Plot 5, JNPT, Navi Mumbai");
  });

  it("manual entry with an unknown fieldKey → 400 (allowlist, not free text)", async () => {
    const bol = await prisma.document.findFirstOrThrow({
      where: { shipment: { ref: "SHP-24811" }, type: "BILL_OF_LADING" },
    });
    const res = await manualRoute.POST(
      req(`/api/documents/${bol.id}/manual`, {
        method: "POST",
        body: { fields: [{ fieldKey: "notAField", value: "x" }] },
        cookie: execCookie,
      }),
      ctx({ id: bol.id }),
    );
    expect(res.status).toBe(400);
  });

  it("manual entry with an unparseable number → 422 and ZERO persistence (atomic rollback)", async () => {
    const sBefore = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const auditsBefore = await prisma.auditEvent.count({ where: { shipmentId: sBefore.id } });
    const bol = await prisma.document.findFirstOrThrow({
      where: { shipment: { ref: "SHP-24811" }, type: "PACKING_LIST" },
    });
    const res = await manualRoute.POST(
      req(`/api/documents/${bol.id}/manual`, {
        method: "POST",
        body: { fields: [{ fieldKey: "grossWeightKg", value: "not-a-weight" }] },
        cookie: execCookie,
      }),
      ctx({ id: bol.id }),
    );
    expect(res.status).toBe(422);
    const sAfter = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    expect(sAfter.updatedAt.getTime()).toBe(sBefore.updatedAt.getTime()); // nothing written
    expect(await prisma.auditEvent.count({ where: { shipmentId: sBefore.id } })).toBe(auditsBefore);
  });

  it("confirming ALL remaining fields → READY_FOR_APPROVAL (blocking 0 + cleared)", async () => {
    // loop until no AI_DRAFT fields remain (each confirm may unlock nothing new)
    for (let round = 0; round < 3; round++) {
      const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
      const drafts = await prisma.extractedField.findMany({
        where: { shipmentId: s.id, status: "AI_DRAFT" },
        select: { id: true },
      });
      if (drafts.length === 0) break;
      for (const f of drafts) {
        await fieldRoute.PATCH(
          req(`/api/shipments/${s.id}/fields/${f.id}`, { method: "PATCH", body: {}, cookie: execCookie }),
          ctx({ id: s.id, fieldId: f.id }),
        );
      }
    }
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    expect(s.status).toBe("READY_FOR_APPROVAL");
  });
});

describe("approval + export gates (rows 14–17)", () => {
  it("approve unready (DRAFT, no docs) → 409 with the EXACT missing criteria", async () => {
    // Self-contained precondition (no reliance on other tests' side effects) and
    // valid regardless of non-fixture rows in a shared dev DB.
    const execUser = await prisma.user.findUniqueOrThrow({ where: { email: EXEC } });
    const draft = await prisma.shipment.create({
      data: { ref: `SHP-T-UNREADY-${Date.now()}`, status: "DRAFT", createdById: execUser.id },
    });
    const res = await approveRoute.POST(
      req(`/api/shipments/${draft.id}/approve`, { method: "POST", cookie: mgrCookie }),
      ctx({ id: draft.id }),
    );
    expect(res.status).toBe(409);
    const body = (await jsonOf(res)) as { error: { code: string; details: { status: string; unresolvedBlockingChecks: unknown[] } } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details.status).toBe("DRAFT");
  });

  it("manager approve → APPROVED + APPROVAL_GRANTED + approver recorded", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const res = await approveRoute.POST(
      req(`/api/shipments/${s.id}/approve`, { method: "POST", cookie: mgrCookie }),
      ctx({ id: s.id }),
    );
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { shipment: { status: string; approvedById: string | null } };
    expect(body.shipment.status).toBe("APPROVED");
    expect(body.shipment.approvedById).toBe((await prisma.user.findUniqueOrThrow({ where: { email: MGR } })).id);
  });

  it("revoke → NEEDS_REVIEW + APPROVAL_REVOKED + approver cleared", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const res = await revokeRoute.POST(
      req(`/api/shipments/${s.id}/revoke`, { method: "POST", cookie: mgrCookie }),
      ctx({ id: s.id }),
    );
    expect(res.status).toBe(200);
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("NEEDS_REVIEW");
    expect(after.approvedById).toBeNull();
  });

  it("export from NEEDS_REVIEW → 409 (gate returns exact missing criteria)", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const res = await exportRoute.POST(
      req(`/api/shipments/${s.id}/export`, { method: "POST", cookie: execCookie }),
      ctx({ id: s.id }),
    );
    expect(res.status).toBe(409);
    const body = (await jsonOf(res)) as { error: { details: { status: string } } };
    expect(body.error.details.status).toBe("NEEDS_REVIEW");
  });

  it("re-approve → export 201 → status EXPORTED + record + EXPORT_GENERATED", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    // Revoke left the shipment in NEEDS_REVIEW; APPROVE is only legal from
    // READY_FOR_APPROVAL, and a recompute happens on the next human write —
    // so correct one field (same value) to drive NEEDS_REVIEW → READY.
    const invFieldId = await fieldIdOf("SHP-24811", "INVOICE", "invoiceNumber");
    const touch = await fieldRoute.PATCH(
      req(`/api/shipments/${s.id}/fields/${invFieldId}`, {
        method: "PATCH",
        body: { value: "INV-CB-8841" },
        cookie: execCookie,
      }),
      ctx({ id: s.id, fieldId: invFieldId }),
    );
    expect(touch.status).toBe(200);
    const touched = (await jsonOf(touch)) as { shipmentStatus: string };
    expect(touched.shipmentStatus).toBe("READY_FOR_APPROVAL");

    const approveRes = await approveRoute.POST(
      req(`/api/shipments/${s.id}/approve`, { method: "POST", cookie: mgrCookie }),
      ctx({ id: s.id }),
    );
    expect(approveRes.status).toBe(200);

    const res = await exportRoute.POST(
      req(`/api/shipments/${s.id}/export`, { method: "POST", cookie: execCookie }),
      ctx({ id: s.id }),
    );
    expect(res.status).toBe(201);
    const body = (await jsonOf(res)) as { exportRecord: { fileName: string; formatVersion: string; csvSha256: string } };
    expect(body.exportRecord.formatVersion).toBe("cargolens-csv-v1");
    expect(body.exportRecord.fileName).toContain("SHP-24811");
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "EXPORTED" });
  });

  it("latest export → exact CSV bytes (ref + line item inside), EXPORT_DOWNLOADED audited", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const res = await exportLatestRoute.GET(
      req(`/api/shipments/${s.id}/export/latest`, { cookie: execCookie }),
      ctx({ id: s.id }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain("shipmentRef");
    expect(csv).toContain("SHP-24811");
    expect(csv).toContain("LED panel light 40W");
    expect(csv.endsWith("\r\n")).toBe(true);

    const downloaded = await prisma.auditEvent.findFirstOrThrow({
      where: { shipmentId: s.id, action: "EXPORT_DOWNLOADED" },
    });
    expect(downloaded.actorName).toBe("API Executive"); // the downloader is audited
  });

  it("writes after EXPORTED → 409 (terminal state enforced)", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const fieldId = await fieldIdOf("SHP-24811", "INVOICE", "invoiceNumber");
    const res = await fieldRoute.PATCH(
      req(`/api/shipments/${s.id}/fields/${fieldId}`, {
        method: "PATCH",
        body: { value: "INV-CB-8841" }, // a correction (repeat-confirm would early-return by design)
        cookie: execCookie,
      }),
      ctx({ id: s.id, fieldId }),
    );
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("no export exists → latest 404", async () => {
    // Self-contained precondition: a shipment with no export record, independent
    // of other tests and of non-fixture rows in a shared dev DB.
    const execUser = await prisma.user.findUniqueOrThrow({ where: { email: EXEC } });
    const fresh = await prisma.shipment.create({
      data: { ref: `SHP-T-NOEXP-${Date.now()}`, status: "DRAFT", createdById: execUser.id },
    });
    const res = await exportLatestRoute.GET(
      req(`/api/shipments/${fresh.id}/export/latest`, { cookie: execCookie }),
      ctx({ id: fresh.id }),
    );
    expect(res.status).toBe(404);
  });
});

describe("ledger + reports (rows 18–19)", () => {
  it("audit ledger for SHP-24811 lists the whole story, newest first", async () => {
    const s = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    const res = await auditRoute.GET(req(`/api/shipments/${s.id}/audit`, { cookie: execCookie }), ctx({ id: s.id }));
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { events: { action: string }[] };
    const actions = body.events.map((e) => e.action);
    for (const expected of [
      "SHIPMENT_CREATED",
      "FIELD_CONFIRMED",
      "DISCREPANCY_RESOLVED",
      "FIELD_CORRECTED",
      "MANUAL_ENTRY",
      "CHECKS_RECOMPUTED",
      "APPROVAL_GRANTED",
      "APPROVAL_REVOKED",
      "EXPORT_GENERATED",
      "EXPORT_DOWNLOADED",
    ]) {
      expect(actions).toContain(expected);
    }
  });

  it("accuracy groupBy=field → grossWeightKg shows human-cleared counts", async () => {
    const res = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=field", { cookie: execCookie }));
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { groupBy: string; rows: { fieldKey: string; total: number; confirmed: number }[] };
    expect(body.groupBy).toBe("field");
    const weight = body.rows.find((r) => r.fieldKey === "grossWeightKg")!;
    expect(weight.total).toBeGreaterThanOrEqual(6);
    expect(weight.confirmed).toBeGreaterThanOrEqual(2);
  });

  it("accuracy groupBy=supplier → per-supplier aggregates", async () => {
    const res = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=supplier", { cookie: execCookie }));
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { rows: { supplierName: string | null; fieldsTotal: number }[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.some((r) => r.supplierName === "Company B (China)")).toBe(true);
  });

  it("accuracy with bad groupBy → 400", async () => {
    const res = await accuracyRoute.GET(req("/api/reports/accuracy?groupBy=all", { cookie: execCookie }));
    expect(res.status).toBe(400);
  });
});

describe("logout (row 2)", () => {
  it("logout → cookie cleared; the SAME cookie no longer authenticates", async () => {
    const freshCookie = await loginAndGetCookie(EXEC);
    const res = await logoutRoute.POST(req("/api/auth/logout", { method: "POST", cookie: freshCookie }));
    expect(res.status).toBe(200);
    const me = await meRoute.GET(req("/api/auth/me", { cookie: freshCookie }));
    expect(me.status).toBe(401);
  });
});
