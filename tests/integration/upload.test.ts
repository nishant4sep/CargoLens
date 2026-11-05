/**
 * INTEGRATION — document upload + signed-file access (contract rows 8 and 11,
 * the security core of Phase 4). Runs via `npm run test:seed`; files are
 * sequential (api < seed-idempotency < upload alphabetically), so afterAll
 * MUST restore pristine fixtures exactly like api.test.ts does.
 *
 * Storage is redirected to a throwaway temp dir via STORAGE_DIR (the storage
 * module reads it at call time) — the repo's .storage dir is never touched.
 *
 * The auth model under test: the 302 route DEMANDS a session; the /api/files/
 * token route accepts ONLY a valid unexpired HMAC token (S3-presigned model).
 */
import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runSeed } from "@/server/seed/run";
import { SESSION_COOKIE } from "@/server/http";
import { signFileToken } from "@/server/storage";
import * as loginRoute from "@/app/api/auth/login/route";
import * as shipmentsRoute from "@/app/api/shipments/route";
import * as uploadRoute from "@/app/api/shipments/[id]/documents/route";
import * as fileRedirectRoute from "@/app/api/documents/[id]/file/route";
import * as fileStreamRoute from "@/app/api/files/[token]/route";

const PASSWORD = process.env.SEED_DEMO_PASSWORD || "cargolens-demo-password-123";
const EXEC = "exec-upload@demo.cargolens.in";

let execCookie = "";
let storageDir = "";
let shipmentId = "";

// A minimal VALID PDF (magic bytes) / JPEG / PNG headers for sniffing tests.
const PDF_HEAD = Buffer.from("%PDF-1.4\n% test\n");
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TEXT_BODY = Buffer.from("hello, this is definitely not a pdf, jpeg or png");

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

async function loginAndGetCookie(email: string): Promise<string> {
  const res = await loginRoute.POST(
    req("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: PASSWORD }), contentType: "application/json" }),
  );
  const raw = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(raw);
  if (!m) throw new Error(`login for ${email} produced no session cookie (status ${res.status})`);
  return `${SESSION_COOKIE}=${m[1]}`;
}

function multipart(type: string, content: Buffer, fileName: string): FormData {
  const form = new FormData();
  form.set("type", type);
  form.set("file", new File([new Uint8Array(content)], fileName, { type: "application/octet-stream" }));
  return form;
}

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), "cargolens-upload-test-"));
  process.env.STORAGE_DIR = storageDir;

  await runSeed({ seedFlag: "true" });
  const existing = await prisma.user.findUnique({ where: { email: EXEC } });
  if (!existing) {
    await auth.api.signUpEmail({ body: { email: EXEC, name: "Upload Executive", password: PASSWORD } });
  }
  await prisma.user.update({ where: { email: EXEC }, data: { role: "EXECUTIVE" } });
  execCookie = await loginAndGetCookie(EXEC);

  // the shipment under test, created through the real API
  const res = await shipmentsRoute.POST(
    req("/api/shipments", { method: "POST", body: JSON.stringify({ supplierName: "Upload Test Co" }), contentType: "application/json", cookie: execCookie }),
  );
  expect(res.status).toBe(201);
  const body = await jsonOf(res);
  shipmentId = (body.shipment as { id: string }).id;
});

afterAll(async () => {
  rmSync(storageDir, { recursive: true, force: true }); // throwaway storage dir gone
  await prisma.shipment.deleteMany({}); // cascades documents/fields/checks/audit
  // this suite created a supplier via POST /api/shipments — remove it too, or
  // seed-idempotency (which may run AFTER this file) counts 3 suppliers, not 2
  await prisma.supplier.deleteMany({ where: { name: "Upload Test Co" } });
  await prisma.user.deleteMany({ where: { email: EXEC } });
  await runSeed({ seedFlag: "true" }); // pristine fixtures for any later file
});

describe("upload authorization & validation (row 8)", () => {
  it("upload without a session → 401", async () => {
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: multipart("INVOICE", PDF_HEAD, "a.pdf") }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(401);
  });

  it("upload to an unknown shipment → 404", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const res = await uploadRoute.POST(
      req(`/api/shipments/${ghost}/documents`, { method: "POST", body: multipart("INVOICE", PDF_HEAD, "a.pdf"), cookie: execCookie }),
      ctx({ id: ghost }),
    );
    expect(res.status).toBe(404);
  });

  it("non-multipart body → 400", async () => {
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: JSON.stringify({ type: "INVOICE" }), contentType: "application/json", cookie: execCookie }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("invalid type → 400 (pinned enum, not free text)", async () => {
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: multipart("PASSPORT", PDF_HEAD, "a.pdf"), cookie: execCookie }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(400);
  });

  it("missing file part → 400", async () => {
    const form = new FormData();
    form.set("type", "INVOICE");
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: form, cookie: execCookie }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(400);
  });

  it("content that is not PDF/JPEG/PNG → 400, magic bytes over file name", async () => {
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: multipart("INVOICE", TEXT_BODY, "invoice.pdf"), cookie: execCookie }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    // nothing was persisted or stored
    expect(await prisma.document.count({ where: { shipmentId } })).toBe(0);
  });

  it("file over 10 MB → 413 with the envelope's VALIDATION_ERROR code", async () => {
    const big = Buffer.concat([PDF_HEAD, Buffer.alloc(10 * 1024 * 1024, 0x20)]);
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: multipart("INVOICE", big, "big.pdf"), cookie: execCookie }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(413);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("happy path: 201, UPLOADED, sha256 matches, randomized storage name, DOCUMENT_UPLOADED audited", async () => {
    const content = Buffer.concat([PDF_HEAD, Buffer.from("destination: JNPT")]);
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: multipart("INVOICE", content, "my-invoice.pdf"), cookie: execCookie }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    const document = body.document as { id: string; status: string; mimeType: string; sizeBytes: string };

    expect(document.status).toBe("UPLOADED");
    expect(document.mimeType).toBe("application/pdf");
    expect(BigInt(document.sizeBytes)).toBe(BigInt(content.length));
    // Storage internals (sha256, storagePath) are deliberately NOT in the API
    // response — same shape as the detail endpoint. Verify them at the source.
    const row = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.sha256Hex).toBe(createHash("sha256").update(content).digest("hex"));
    expect(row.storagePath.startsWith("local://")).toBe(true);
    // the original file name must NEVER appear in the storage path (randomized names)
    expect(row.storagePath).not.toContain("my-invoice");

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { shipmentId, action: "DOCUMENT_UPLOADED" },
    });
    expect(audit.actorName).toBe("Upload Executive");
  });

  it("second upload of the same type → 409 CONFLICT (real constraint), first row untouched", async () => {
    const res = await uploadRoute.POST(
      req(`/api/shipments/${shipmentId}/documents`, { method: "POST", body: multipart("INVOICE", PDF_HEAD, "another.pdf"), cookie: execCookie }),
      ctx({ id: shipmentId }),
    );
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await prisma.document.count({ where: { shipmentId, type: "INVOICE" } })).toBe(1);
  });
});

describe("signed-file access (row 11 + the /api/files capability route)", () => {
  it("302 route without a session → 401 (issuing a URL is the guarded act)", async () => {
    const doc = await prisma.document.findFirstOrThrow({ where: { shipmentId, type: "INVOICE" } });
    const res = await fileRedirectRoute.GET(req(`/api/documents/${doc.id}/file`), ctx({ id: doc.id }));
    expect(res.status).toBe(401);
  });

  it("302 route with a session → 302 to /api/files/<token>", async () => {
    const doc = await prisma.document.findFirstOrThrow({ where: { shipmentId, type: "INVOICE" } });
    const res = await fileRedirectRoute.GET(req(`/api/documents/${doc.id}/file`, { cookie: execCookie }), ctx({ id: doc.id }));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/api/files/");
    // ...and the capability alone streams the bytes: no cookie, correct type
    const token = new URL(location).pathname.split("/").pop()!;
    const stream = await fileStreamRoute.GET(req(`/api/files/${token}`), ctx({ token }));
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("application/pdf");
    expect(stream.headers.get("cache-control")).toContain("no-store");
  });

  it("expired token → 403", async () => {
    const token = signFileToken((await prisma.document.findFirstOrThrow({ where: { shipmentId, type: "INVOICE" } })).id, -1);
    const res = await fileStreamRoute.GET(req(`/api/files/${token}`), ctx({ token }));
    expect(res.status).toBe(403);
    expect(await jsonOf(res)).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("tampered token → 403 (signature check is timing-safe)", async () => {
    const token = signFileToken((await prisma.document.findFirstOrThrow({ where: { shipmentId, type: "INVOICE" } })).id);
    const forged = token.slice(0, -2) + (token.endsWith("A") ? "B" : "A");
    const res = await fileStreamRoute.GET(req(`/api/files/${forged}`), ctx({ token: forged }));
    expect(res.status).toBe(403);
  });

  it("valid token for a since-deleted document → 404", async () => {
    const token = signFileToken("00000000-0000-4000-8000-000000000000", 300);
    const res = await fileStreamRoute.GET(req(`/api/files/${token}`), ctx({ token }));
    expect(res.status).toBe(404);
  });

  it("streamed bytes are EXACTLY what was uploaded (integrity)", async () => {
    const doc = await prisma.document.findFirstOrThrow({ where: { shipmentId, type: "INVOICE" } });
    const res = await fileRedirectRoute.GET(req(`/api/documents/${doc.id}/file`, { cookie: execCookie }), ctx({ id: doc.id }));
    const token = new URL(res.headers.get("location")!).pathname.split("/").pop()!;
    const stream = await fileStreamRoute.GET(req(`/api/files/${token}`), ctx({ token }));
    const bytes = Buffer.from(await stream.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(doc.sha256Hex);
  });
});
