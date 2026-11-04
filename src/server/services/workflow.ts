/**
 * Approval + export workflow (contract rows 14–17): manager-only gates and the
 * "nothing exports until cleared" rule — the state machine is the first gate,
 * the service re-verifies blocking state as the second (file 04 §6 groups 2–3).
 */
import { createHash } from "node:crypto";
import { ApiError, type AuthUser } from "@/server/http";
import { prisma } from "@/lib/prisma";
import { transition, type ShipmentStatus } from "@/server/engines/state-machine";
import { CSV_FORMAT_VERSION, EXPORT_HEADER, toCsv, type ExportRow } from "@/server/engines/csv";
import { columnsToTyped } from "./snapshots";
import { writeAudit } from "./audit";
import { type FieldKey } from "@/lib/types";

/** The export gate's EXACT missing criteria — the 409 body is demo gold (file 04). */
function missingCriteria(
  status: string,
  checks: { ruleKey: string; result: string; severity: string; resolvedAt: Date | null }[],
  fields: { status: string }[],
) {
  const blocking = checks
    .filter((c) => c.result === "FAIL" && c.severity === "BLOCKING" && c.resolvedAt === null)
    .map((c) => c.ruleKey);
  return {
    status,
    unresolvedBlockingChecks: blocking,
    unclearedFieldCount: fields.filter((f) => f.status === "AI_DRAFT").length,
  };
}

export async function approveShipment(user: AuthUser, shipmentId: string) {
  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      checks: { select: { ruleKey: true, result: true, severity: true, resolvedAt: true } },
      fields: { select: { status: true } },
    },
  });
  if (!s) throw new ApiError("NOT_FOUND", "Shipment not found", { shipmentId });

  const t = transition(s.status as ShipmentStatus, { type: "APPROVE" });
  if (!t.ok) {
    throw new ApiError("CONFLICT", `Cannot approve: ${t.reason}`, missingCriteria(s.status, s.checks, s.fields));
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.shipment.update({
      where: { id: s.id },
      data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date() },
      include: { supplier: { select: { id: true, name: true, country: true } } },
    });
    await writeAudit(tx, {
      shipmentId: s.id,
      shipmentRef: s.ref,
      action: "APPROVAL_GRANTED",
      actorId: user.id,
      actorName: user.name,
      payload: { ref: s.ref },
    });
    return updated;
  });
}

export async function revokeShipment(user: AuthUser, shipmentId: string) {
  const s = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!s) throw new ApiError("NOT_FOUND", "Shipment not found", { shipmentId });

  const t = transition(s.status as ShipmentStatus, { type: "APPROVAL_REVOKED_MANUALLY" });
  if (!t.ok) throw new ApiError("CONFLICT", `Cannot revoke: ${t.reason}`, { status: s.status });

  return prisma.$transaction(async (tx) => {
    const updated = await tx.shipment.update({
      where: { id: s.id },
      data: { status: t.next, approvedById: null, approvedAt: null },
      include: { supplier: { select: { id: true, name: true, country: true } } },
    });
    await writeAudit(tx, {
      shipmentId: s.id,
      shipmentRef: s.ref,
      action: "APPROVAL_REVOKED",
      actorId: user.id,
      actorName: user.name,
      payload: { reason: "MANUAL" },
    });
    return updated;
  });
}

export async function generateExport(user: AuthUser, shipmentId: string) {
  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      supplier: true,
      documents: { include: { fields: true, lineItems: { orderBy: { seq: "asc" } } } },
      checks: { select: { ruleKey: true, result: true, severity: true, resolvedAt: true } },
    },
  });
  if (!s) throw new ApiError("NOT_FOUND", "Shipment not found", { shipmentId });

  // First gate: the state machine (EXPORT only from APPROVED).
  const t = transition(s.status as ShipmentStatus, { type: "EXPORT" });
  // Second gate: live unresolved blocking state (defense in depth).
  const blocking = s.checks.filter(
    (c) => c.result === "FAIL" && c.severity === "BLOCKING" && c.resolvedAt === null,
  );
  if (!t.ok || blocking.length > 0) {
    throw new ApiError(
      "CONFLICT",
      `Export blocked: ${t.ok ? "unresolved blocking checks" : t.reason}`,
      missingCriteria(s.status, s.checks, s.documents.flatMap((d) => d.fields)),
    );
  }

  const invoice = s.documents.find((d) => d.type === "INVOICE") ?? s.documents[0];
  const fieldRows = s.documents.flatMap((d) => d.fields);
  const valueOf = (key: FieldKey): string | number | null => {
    const f = fieldRows.find((x) => x.fieldKey === key);
    if (!f) return null;
    const typed = columnsToTyped(f);
    if (!typed) return null;
    if (typed.kind === "MONEY" || typed.kind === "WEIGHT_KG" || typed.kind === "QTY") {
      return typed.value / 1000; // milli → real for the CSV
    }
    return typed.value;
  };
  const base: ExportRow = {
    shipmentRef: s.ref,
    supplierName: s.supplier?.name ?? null,
    supplierCountry: s.supplier?.country ?? null,
    invoiceNumber: valueOf("invoiceNumber"),
    invoiceDate: valueOf("invoiceDate"),
    currency: valueOf("currency"),
    incoterm: valueOf("incoterm"),
    totalValue: valueOf("totalValue"),
    grossWeightKg: valueOf("grossWeightKg"),
    netWeightKg: valueOf("netWeightKg"),
    packagesCount: valueOf("packagesCount"),
    containerNumber: valueOf("containerNumber"),
    bolNumber: valueOf("bolNumber"),
    vesselName: valueOf("vesselName"),
    portOfLoading: valueOf("portOfLoading"),
    portOfDischarge: valueOf("portOfDischarge"),
  };
  const lines = invoice ? invoice.lineItems : [];
  const rows: ExportRow[] =
    lines.length === 0
      ? [{ ...base, lineSeq: null, lineDescription: null, hsnCode: null, quantity: null, unit: null, unitPrice: null, lineTotal: null }]
      : lines.map((li) => ({
          ...base,
          lineSeq: li.seq,
          lineDescription: li.description,
          hsnCode: li.hsnCode,
          quantity: li.quantity.toNumber(),
          unit: li.unit,
          unitPrice: li.unitPrice?.toNumber() ?? null,
          lineTotal: li.lineTotal?.toNumber() ?? null,
        }));
  const csv = toCsv(EXPORT_HEADER, rows);
  const csvSha256 = createHash("sha256").update(csv).digest("hex");
  const fileName = `${s.ref}-${CSV_FORMAT_VERSION}.csv`;

  return prisma.$transaction(async (tx) => {
    // Transition (EXPORT → EXPORTED) persisted in the SAME tx as the record + audit.
    await tx.shipment.update({ where: { id: s.id }, data: { status: t.next } });
    const record = await tx.exportRecord.create({
      data: {
        shipmentId: s.id,
        createdById: user.id,
        formatVersion: CSV_FORMAT_VERSION,
        fileName,
        csvContent: csv,
        csvSha256,
      },
      select: { id: true, fileName: true, formatVersion: true, csvSha256: true, createdAt: true },
    });
    await writeAudit(tx, {
      shipmentId: s.id,
      shipmentRef: s.ref,
      action: "EXPORT_GENERATED",
      actorId: user.id,
      actorName: user.name,
      payload: { exportId: record.id, fileName, csvSha256, bytes: csv.length },
    });
    return record;
  });
}

export async function getLatestExport(user: AuthUser, shipmentId: string) {
  const s = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, ref: true } });
  if (!s) throw new ApiError("NOT_FOUND", "Shipment not found", { shipmentId });
  const record = await prisma.exportRecord.findFirst({
    where: { shipmentId },
    orderBy: { createdAt: "desc" },
  });
  if (!record) throw new ApiError("NOT_FOUND", "No export exists for this shipment");
  await writeAudit(prisma, {
    shipmentId,
    shipmentRef: s.ref,
    action: "EXPORT_DOWNLOADED",
    actorId: user.id,
    actorName: user.name,
    payload: { exportId: record.id, fileName: record.fileName },
  });
  return record;
}
