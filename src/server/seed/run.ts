/**
 * Idempotent seed orchestrator — "ensure, never overwrite" semantics.
 *
 * Design principles (full write-up: isocode-preparation/12, Entry 4):
 *  1. PASSWORDS ONLY THROUGH better-auth: accounts are created via
 *     auth.api.signUpEmail, which owns scrypt hashing + the credential account
 *     row. This code never hashes, never stores plaintext, and the demo
 *     password comes from env (SEED_DEMO_PASSWORD), never source.
 *  2. ROLES ARE SERVER-ASSIGNED: written directly via prisma AFTER signup —
 *     the auth config declares role input:false (server-owned), so no API
 *     path can grant roles; the DB Role enum constrains values.
 *  3. ADDITIVE ONLY (idempotency): every entity is ensured with
 *     find-then-create (create ONLY when missing) — re-running never
 *     duplicates and never disturbs demo state a human shaped (confirmed
 *     fields, resolved checks). Gaps from partial seeds are filled.
 *     Single-invoker assumption is explicit: the seed is a human CLI action
 *     in this project, so no upsert/race machinery is warranted.
 *  4. DETERMINISTIC: same fixtures + engine → same rows, same check statuses.
 *
 * Relative imports only (no "@/" alias): this module must also run under tsx
 * (prisma db seed), which does not resolve the vitest/tsconfig alias.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { auth } from "../../lib/auth";
import { prisma } from "../../lib/prisma";
import { runChecks, unresolvedBlockingCount } from "../engines/crosschecks";
import { transition } from "../engines/state-machine";
import type { TypedFieldValue } from "../../lib/types";
import { assertSyntheticSeed } from "./guard";
import {
  DEMO_SHIPMENTS,
  DEMO_SUPPLIERS,
  DEMO_USERS,
  FIELD_CONFIDENCE,
  buildSnapshots,
} from "./fixtures";

export interface SeedSummary {
  flag: "true";
  users: { created: string[]; kept: string[] };
  suppliers: { created: string[]; kept: string[] };
  shipments: { created: string[]; kept: string[] };
  documentsCreated: number;
  fieldsCreated: number;
  lineItemsCreated: number;
  checksCreated: number;
  auditsCreated: number;
  statusTransitions: string[];
}

/** DB columns carry real-precision decimals; engine carries milli (×1000). */
function milliToReal(milli: number): number {
  return Number(BigInt(milli)) / 1000;
}

/** Typed engine value → the four nullable columns of ExtractedField. */
function typedValueToColumns(
  v: TypedFieldValue,
): { valueText?: string; valueNumeric?: number; valueDate?: Date; currency?: string | null } {
  switch (v.kind) {
    case "TEXT":
      return { valueText: v.value };
    case "DATE":
      return { valueDate: new Date(`${v.value}T00:00:00.000Z`) };
    case "MONEY":
      return { valueNumeric: milliToReal(v.value), currency: v.currency };
    case "QTY":
    case "WEIGHT_KG":
    case "COUNT":
      return { valueNumeric: milliToReal(v.value) };
  }
}

/**
 * Runs the full seed. The guard is checked BEFORE anything else — including
 * before this module's own Prisma connection is used at all, so a rejected
 * run leaves the database bit-identical (proven by the integration test).
 */
export async function runSeed(opts: { seedFlag?: string | null } = {}): Promise<SeedSummary> {
  assertSyntheticSeed(opts.seedFlag ?? process.env.SEED_SYNTHETIC);

  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password) {
    throw new Error("SEED_DEMO_PASSWORD is not set — demo accounts cannot be created");
  }

  const summary: SeedSummary = {
    flag: "true",
    users: { created: [], kept: [] },
    suppliers: { created: [], kept: [] },
    shipments: { created: [], kept: [] },
    documentsCreated: 0,
    fieldsCreated: 0,
    lineItemsCreated: 0,
    checksCreated: 0,
    auditsCreated: 0,
    statusTransitions: [],
  };

  /* ---- users (better-auth owns creation + hashing) --------------------- */
  for (const spec of DEMO_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: spec.email } });
    if (existing) {
      // Self-healing ONLY for our facility roles (server-owned), never for
      // anything a demo user changed in the product UI.
      if (existing.role !== spec.role) {
        await prisma.user.update({ where: { email: spec.email }, data: { role: spec.role } });
      }
      summary.users.kept.push(spec.email);
      continue;
    }
    await auth.api.signUpEmail({
      body: { email: spec.email, name: spec.name, password },
    });
    // role is server-owned (input:false in the auth config) — assigned right
    // after creation so both demo roles exist despite the EXECUTIVE DB default.
    await prisma.user.update({ where: { email: spec.email }, data: { role: spec.role } });
    summary.users.created.push(spec.email);
  }

  /* ---- suppliers (reference data, ensured by unique name) -------------- */
  for (const s of DEMO_SUPPLIERS) {
    const found = await prisma.supplier.findUnique({ where: { name: s.name } });
    if (found) {
      summary.suppliers.kept.push(s.name);
      continue;
    }
    await prisma.supplier.create({ data: { name: s.name, country: s.country } });
    summary.suppliers.created.push(s.name);
  }

  const exec = await prisma.user.findUniqueOrThrow({ where: { email: "exec@demo.cargolens.in" } });

  /* ---- shipments: documents, fields, line items, checks ---------------- */
  for (const spec of DEMO_SHIPMENTS) {
    let shipment = await prisma.shipment.findUnique({ where: { ref: spec.ref } });
    if (!shipment) {
      const supplier = await prisma.supplier.findUniqueOrThrow({ where: { name: spec.supplierName } });
      shipment = await prisma.shipment.create({
        data: { ref: spec.ref, supplierId: supplier.id, createdById: exec.id },
      });
      await prisma.auditEvent.create({
        data: {
          shipmentId: shipment.id,
          shipmentRef: spec.ref,
          action: "SHIPMENT_CREATED",
          actorId: exec.id,
          actorName: "Seed (synthetic)",
          payload: { source: "seed", synthetic: true },
        },
      });
      summary.auditsCreated += 1;
      summary.shipments.created.push(spec.ref);
    } else {
      summary.shipments.kept.push(spec.ref);
    }

    for (const doc of spec.docs) {
      // Storage is Phase-4 work; until then synthetic docs point at clearly
      // labelled synthetic:// paths — never pretending to be real uploads.
      const storagePath = `synthetic://demo/${spec.ref}/${doc.type}`;
      let dRow = await prisma.document.findUnique({
        where: { shipmentId_type: { shipmentId: shipment.id, type: doc.type } },
      });
      if (!dRow) {
        dRow = await prisma.document.create({
          data: {
            shipmentId: shipment.id,
            type: doc.type,
            status: "PROCESSED",
            storagePath,
            fileName: `SYNTHETIC-${doc.type}.txt`,
            mimeType: "text/plain",
            sizeBytes: 1234n,
            sha256Hex: createHash("sha256").update(storagePath).digest("hex"),
            extractedAt: new Date(),
            uploadedById: null, // synthetic: nobody uploaded a real file
          },
        });
        summary.documentsCreated += 1;
      }

      for (const [key, value] of Object.entries(doc.fields) as [string, TypedFieldValue][]) {
        const cols = typedValueToColumns(value);
        const exists = await prisma.extractedField.findUnique({
          where: { documentId_fieldKey: { documentId: dRow.id, fieldKey: key } },
        });
        if (exists) continue; // confirmed/corrected demo state survives re-seeds
        await prisma.extractedField.create({
          data: {
            shipmentId: shipment.id,
            documentId: dRow.id,
            fieldKey: key,
            isUnreadable: false,
            ...cols,
            confidence: FIELD_CONFIDENCE[key as keyof typeof FIELD_CONFIDENCE] ?? 0.95,
            sourcePage: 1,
            status: "AI_DRAFT",
          },
        });
        summary.fieldsCreated += 1;
      }

      for (const li of doc.lineItems) {
        const exists = await prisma.lineItem.findUnique({
          where: { documentId_seq: { documentId: dRow.id, seq: li.seq } },
        });
        if (exists) continue;
        await prisma.lineItem.create({
          data: {
            shipmentId: shipment.id,
            documentId: dRow.id,
            seq: li.seq,
            description: li.description,
            hsnCode: li.hsnCode,
            unit: li.unit,
            quantity: milliToReal(li.qtyMilli),
            unitPrice: milliToReal(li.unitPriceMilli),
            lineTotal: Number(BigInt(li.qtyMilli) * BigInt(li.unitPriceMilli)) / 1_000_000,
          },
        });
        summary.lineItemsCreated += 1;
      }
    }

    /* ---- deterministic cross-check rows (same engine the product uses) -- */
    const results = runChecks(buildSnapshots(spec));
    const produced = unresolvedBlockingCount(results);
    if (produced !== spec.expectedBlockingFails) {
      throw new Error(
        `Seed integrity: ${spec.ref} expected exactly ${spec.expectedBlockingFails} ` +
          `blocking fail(s) per fixture spec, engine produced ${produced} — ` +
          "refusing to seed inconsistent demo data",
      );
    }
    for (const r of results) {
      const exists = await prisma.crossCheck.findUnique({
        where: { shipmentId_ruleKey: { shipmentId: shipment.id, ruleKey: r.ruleKey } },
      });
      if (exists) continue;
      // Engine payloads are plain JSON (records / arrays / numbers / strings);
      // Prisma's Json column input needs the explicit narrowing.
      const payload = {
        details: r.details ?? null,
        failedRefs: r.failedRefs,
      } as unknown as Prisma.InputJsonValue;
      await prisma.crossCheck.create({
        data: {
          shipmentId: shipment.id,
          ruleKey: r.ruleKey,
          result: r.status,
          severity: r.severity,
          detailsJson: payload,
        },
      });
      summary.checksCreated += 1;
    }

    /* ---- derived status: extraction completed ⇒ NEEDS_REVIEW -------------
     * The fixtures arrive WITH processed documents, extracted fields and
     * engine-computed checks — a shipment left in DRAFT with extraction
     * output would violate the state machine (human writes are illegal in
     * DRAFT, which would freeze every review screen). Derive the status
     * through the SAME engine the product uses (never hand-bake fixture
     * state): DRAFT → EXTRACTION_STARTED → PROCESSING → DOCS_REACHED_TERMINAL
     * → NEEDS_REVIEW. Only from DRAFT: a kept shipment's later demo status is
     * never regressed. */
    const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    if (fresh.status === "DRAFT") {
      const started = transition("DRAFT", { type: "EXTRACTION_STARTED" });
      const done = started.ok ? transition(started.next, { type: "DOCS_REACHED_TERMINAL" }) : started;
      if (done.ok) {
        await prisma.shipment.update({ where: { id: fresh.id }, data: { status: done.next } });
        summary.statusTransitions.push(`DRAFT → ${done.next}`);
      }
    }
  }

  return summary;
}
