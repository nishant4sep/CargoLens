/**
 * INTEGRATION SUITE — runs against the LIVE local dev Postgres (Docker).
 * Not part of `npm test` (pure suites must never require a DB); launched with:
 *
 *     npm run test:seed        (→ vitest run --config vitest.integration.config.mts)
 *
 * Test isolation model: this suite is the ONLY one allowed to write demo data,
 * and ITS OWN execordering is chronological by design — the guard's
 * reject-and-write-nothing cases run BEFORE any seeding is permitted. ADR-09
 * makes this safe: the DB under test is dedicated synthetic demo space, and
 * every acceptance path is guarded by SEED_SYNTHETIC.
 */
import "dotenv/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEMO_SHIPMENTS, DEMO_SUPPLIERS, DEMO_USERS } from "@/server/seed/fixtures";
import { SEED_REFUSED } from "@/server/seed/guard";
import { runSeed } from "@/server/seed/run";

/**
 * NOTE on the negative cases: object property undefined is indistinguishable
 * from an absent property, so `runSeed({ seedFlag: undefined })` correctly
 * FALLS BACK to the environment (that is what the CLI does). To test "run
 * without the flag", we manipulate the environment itself — exactly how a
 * rejected CLI run arises.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

async function counts(): Promise<number[]> {
  const [users, accounts, suppliers, shipments, documents, fields, lines, checks, audits] =
    await Promise.all([
      prisma.user.count(),
      prisma.account.count(),
      prisma.supplier.count(),
      prisma.shipment.count(),
      prisma.document.count(),
      prisma.extractedField.count(),
      prisma.lineItem.count(),
      prisma.crossCheck.count(),
      prisma.auditEvent.count(),
    ]);
  return [users, accounts, suppliers, shipments, documents, fields, lines, checks, audits];
}

describe("negative FIRST — the guard refuses and the database stays bit-identical", () => {
  it("runSeed with NO flag (env-absent) rejects and writes NOTHING", async () => {
    delete process.env.SEED_SYNTHETIC; // truly absent, as in a rejected CLI run
    const before = await counts();
    await expect(runSeed()).rejects.toThrow(SEED_REFUSED);
    expect(await counts()).toEqual(before);
  });

  it("runSeed with a WRONG value rejects and writes NOTHING", async () => {
    vi.stubEnv("SEED_SYNTHETIC", "false");
    const before = await counts();
    await expect(runSeed()).rejects.toThrow(SEED_REFUSED);
    expect(await counts()).toEqual(before);
  });

  it("the seed never leaves plaintext passwords — auth owns hashing", async () => {
    const accounts = await prisma.account.findMany({ where: { providerId: "credential" } });
    for (const a of accounts) {
      expect(a.password).toBeTruthy(); // scrypt hash stored by better-auth
      expect(a.password).not.toBe(process.env.SEED_DEMO_PASSWORD);
      expect((a.password ?? "").length).toBeGreaterThanOrEqual(40); // hash-shaped
    }
  });
});

describe("positive seeding — valid flag creates the demo dataset", () => {
  it("seeds users + credentials + suppliers + shipments + docs + checks", async () => {
    const summary = await runSeed({ seedFlag: "true" });

    // Works in BOTH fresh and re-run states: every demo identity must end up
    // either created by this run or kept from an earlier one.
    const usersAccounted = [...summary.users.created, ...summary.users.kept].sort();
    expect(usersAccounted).toEqual(DEMO_USERS.map((u) => u.email).sort());
    const suppliersAccounted = [...summary.suppliers.created, ...summary.suppliers.kept].sort();
    expect(suppliersAccounted).toEqual(DEMO_SUPPLIERS.map((s) => s.name).sort());
    const shipmentsAccounted = [...summary.shipments.created, ...summary.shipments.kept].sort();
    expect(shipmentsAccounted).toEqual(DEMO_SHIPMENTS.map((s) => s.ref).sort());

    // Assert demo data is present (>=) rather than globally exact so the suite
    // remains valid when non-destructive stray rows exist in a shared dev DB
    // (e.g. a prior E2E byproduct). The "accounted for" checks above prove all
    // demo identities exist; idempotency/heal tests below prove the real semantics.
    expect(await prisma.user.count()).toBeGreaterThanOrEqual(DEMO_USERS.length);
    expect(await prisma.account.count()).toBeGreaterThanOrEqual(DEMO_USERS.length); // credential rows
    expect(await prisma.supplier.count()).toBeGreaterThanOrEqual(DEMO_SUPPLIERS.length);
    expect(await prisma.shipment.count()).toBeGreaterThanOrEqual(DEMO_SHIPMENTS.length);
    expect(await prisma.document.count()).toBeGreaterThanOrEqual(DEMO_SHIPMENTS.length * 3);
    expect(await prisma.auditEvent.count()).toBeGreaterThanOrEqual(DEMO_SHIPMENTS.length); // one SHIPMENT_CREATED each
  });

  it("roles are server-assigned exactly as the facility specs demand", async () => {
    const exec = await prisma.user.findUniqueOrThrow({ where: { email: "exec@demo.cargolens.in" } });
    const mgr = await prisma.user.findUniqueOrThrow({ where: { email: "manager@demo.cargolens.in" } });
    expect(exec.role).toBe("EXECUTIVE");
    expect(mgr.role).toBe("MANAGER");
  });

  it("SHP-24811 carries its single BLOCKING CV-6 fail; SHP-24812 carries none", async () => {
    const s1 = await prisma.shipment.findUniqueOrThrow({
      where: { ref: "SHP-24811" },
      include: { checks: true },
    });
    const blocking = s1.checks.filter((c) => c.result === "FAIL");
    expect(blocking.map((c) => c.ruleKey)).toEqual(["GROSS_WEIGHT_CONSISTENCY"]);
    expect(blocking[0]!.severity).toBe("BLOCKING");

    const s2 = await prisma.shipment.findUniqueOrThrow({
      where: { ref: "SHP-24812" },
      include: { checks: true },
    });
    expect(s2.checks.filter((c) => c.result === "FAIL")).toHaveLength(0);
    expect(s2.checks.every((c) => c.result === "PASS")).toBe(true);
  });

  it("documents are clearly labelled synthetic, with FAKE storage + sha", async () => {
    const docs = await prisma.document.findMany({ include: { shipment: true } });
    expect(docs.length).toBeGreaterThanOrEqual(DEMO_SHIPMENTS.length * 3);
    for (const d of docs) {
      expect(d.storagePath.startsWith("synthetic://demo/")).toBe(true);
      expect(d.fileName.startsWith("SYNTHETIC-")).toBe(true);
      expect(d.uploadedById).toBeNull(); // nobody uploaded real files
    }
  });

  it("fields store REAL-precision decimals (milli contract conversion at the seam)", async () => {
    const s11 = await prisma.shipment.findUniqueOrThrow({
      where: { ref: "SHP-24811" },
      include: {
        documents: { include: { fields: true, lineItems: true } },
      },
    });
    const invoice = s11.documents.find((d) => d.type === "INVOICE")!;
    const total = invoice.fields.find((fd) => fd.fieldKey === "totalValue")!;
    expect(total.valueNumeric?.toNumber()).toBe(16320); // 16,320.00 USD
    expect(total.currency).toBe("USD");
    const line = invoice.lineItems[0]!;
    expect(line.quantity.toNumber()).toBe(2400);
    expect(line.unitPrice?.toNumber()).toBe(6.8);
    expect(line.lineTotal?.toNumber()).toBe(16320); // exact, not float-noise
  });
});

describe("idempotency — re-running never duplicates and never disturbs", () => {
  it("re-seed keeps every id, createdAt, role and value exactly stable", async () => {
    const usersBefore = await prisma.user.findMany({ orderBy: { email: "asc" } });
    const shipmentsBefore = await prisma.shipment.findMany({ orderBy: { ref: "asc" } });
    const fieldsBefore = await prisma.extractedField.findMany({ orderBy: { id: "asc" } });
    const checksBefore = await prisma.crossCheck.findMany({ orderBy: { id: "asc" } });

    const summary = await runSeed({ seedFlag: "true" });
    // second run reports ZERO creations — everything "kept"
    expect(summary.users.created).toHaveLength(0);
    expect(summary.suppliers.created).toHaveLength(0);
    expect(summary.shipments.created).toHaveLength(0);
    expect(summary.documentsCreated).toBe(0);
    expect(summary.fieldsCreated).toBe(0);
    expect(summary.lineItemsCreated).toBe(0);
    expect(summary.checksCreated).toBe(0);

    const usersAfter = await prisma.user.findMany({ orderBy: { email: "asc" } });
    expect(usersAfter.map((u) => [u.id, u.email, u.role, u.createdAt])).toEqual(
      usersBefore.map((u) => [u.id, u.email, u.role, u.createdAt]),
    );
    const shipmentsAfter = await prisma.shipment.findMany({ orderBy: { ref: "asc" } });
    expect(shipmentsAfter.map((s) => [s.id, s.ref, s.createdAt])).toEqual(
      shipmentsBefore.map((s) => [s.id, s.ref, s.createdAt]),
    );
    const fieldsAfter = await prisma.extractedField.findMany({ orderBy: { id: "asc" } });
    expect(fieldsAfter.map((fd) => [fd.id, fd.valueNumeric?.toString(), fd.status])).toEqual(
      fieldsBefore.map((fd) => [fd.id, fd.valueNumeric?.toString(), fd.status]),
    );
    const checksAfter = await prisma.crossCheck.findMany({ orderBy: { id: "asc" } });
    expect(checksAfter.map((c) => [c.id, c.ruleKey, c.result])).toEqual(
      checksBefore.map((c) => [c.id, c.ruleKey, c.result]),
    );
  });

  it("a partial dataset heals: deleting documents only, re-seed restores them", async () => {
    // Simulate a partial/earlier seed run: remove some demo rows (documents +
    // cascade fields/lines) but NOT shipments.
    const s11 = await prisma.shipment.findUniqueOrThrow({ where: { ref: "SHP-24811" } });
    await prisma.document.deleteMany({ where: { shipmentId: s11.id } });

    const summary = await runSeed({ seedFlag: "true" });

    // heal-only: users/suppliers/shipments all kept; documents recreated
    expect(summary.shipments.created).toHaveLength(0);
    expect(summary.documentsCreated).toBe(3);
    expect(await prisma.document.count({ where: { shipmentId: s11.id } })).toBe(3);
    expect(await prisma.extractedField.count({ where: { shipmentId: s11.id } })).toBe(
      21, // 10 invoice + 4 packing list + 7 BOL fields (fixture-defined)
    );
  });
});
