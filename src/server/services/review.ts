/**
 * Review workflow (contract rows 10, 12, 13): the human-write paths that make
 * the brief's side-by-side review real. Every write is ONE transaction
 * (file 04 §6 group 1): field write + audit + recompute + derived status +
 * approval revocation — all or nothing.
 */
import { ApiError, type AuthUser } from "@/server/http";
import { prisma } from "@/lib/prisma";
import { runChecks, type CrossCheckResult } from "@/server/engines/crosschecks";
import {
  transition,
  type ShipmentStatus,
} from "@/server/engines/state-machine";
import { isFieldKey } from "@/lib/types";
import { writeAudit } from "./audit";
import { loadSnapshots, parseCorrection, type CorrectionColumns } from "./snapshots";
import type { ManualEntryInput, PatchFieldInput, ResolveCheckInput } from "@/server/dto";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

function checkPayload(r: CrossCheckResult): Prisma.InputJsonValue {
  return { details: r.details ?? null, failedRefs: r.failedRefs } as unknown as Prisma.InputJsonValue;
}

/**
 * Recomputes checks + derived status INSIDE an open transaction: upserts one
 * CrossCheck row per rule (a recomputed PASS clears any resolution; a FAIL
 * keeps an existing accept-with-note), then fires the state machine's
 * INVARIANTS_RECOMPUTED with the true unresolved-blocking count AND whether
 * every field is human-cleared (READY_FOR_APPROVAL needs both).
 */
async function recomputeInTx(
  tx: Tx,
  shipment: { id: string; ref: string; status: ShipmentStatus },
  actor: AuthUser,
): Promise<{ status: ShipmentStatus; blockingFails: number }> {
  const snapshots = await loadSnapshots(tx, shipment.id);
  const results = runChecks(snapshots);

  const fields = await tx.extractedField.findMany({
    where: { shipmentId: shipment.id },
    select: { status: true },
  });
  const fieldsCleared = fields.length > 0 && fields.every((f) => f.status !== "AI_DRAFT");

  for (const r of results) {
    await tx.crossCheck.upsert({
      where: { shipmentId_ruleKey: { shipmentId: shipment.id, ruleKey: r.ruleKey } },
      create: {
        shipmentId: shipment.id,
        ruleKey: r.ruleKey,
        result: r.status,
        severity: r.severity,
        detailsJson: checkPayload(r),
      },
      update: {
        result: r.status,
        severity: r.severity,
        detailsJson: checkPayload(r),
        ...(r.status === "PASS"
          ? { resolvedById: null, resolvedNote: null, resolvedAt: null }
          : {}), // a standing FAIL keeps its accept-with-note resolution
      },
    });
  }
  const blockingRows = await tx.crossCheck.findMany({
    where: { shipmentId: shipment.id, result: "FAIL", severity: "BLOCKING" },
    select: { resolvedAt: true },
  });
  const blockingFails = blockingRows.filter((c) => c.resolvedAt === null).length;

  const t = transition(shipment.status, { type: "INVARIANTS_RECOMPUTED", blockingFails, fieldsCleared });
  if (!t.ok) throw new ApiError("CONFLICT", t.reason);

  if (t.next !== shipment.status || t.approvalRevoked) {
    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        status: t.next,
        ...(t.approvalRevoked ? { approvedById: null, approvedAt: null } : {}),
      },
    });
  }
  await writeAudit(tx, {
    shipmentId: shipment.id,
    shipmentRef: shipment.ref,
    action: "CHECKS_RECOMPUTED",
    actorId: actor.id,
    actorName: actor.name,
    payload: { blockingFails, fieldsCleared, results: Object.fromEntries(results.map((r) => [r.ruleKey, r.status])) },
  });
  if (t.approvalRevoked) {
    await writeAudit(tx, {
      shipmentId: shipment.id,
      shipmentRef: shipment.ref,
      action: "APPROVAL_REVOKED",
      actorId: actor.id,
      actorName: actor.name,
      payload: { reason: "HUMAN_WRITE" },
    });
  }
  return { status: t.next, blockingFails };
}

/** Applies a HUMAN_WRITE: returns the post-event status, revoking approval if the machine says so. */
async function applyHumanWrite(
  tx: Tx,
  shipment: { id: string; ref: string; status: ShipmentStatus },
  actor: AuthUser,
): Promise<ShipmentStatus> {
  const t = transition(shipment.status, { type: "HUMAN_WRITE" });
  if (!t.ok) throw new ApiError("CONFLICT", `Write not allowed: ${t.reason}`, { status: shipment.status });
  if (t.approvalRevoked) {
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { status: t.next, approvedById: null, approvedAt: null },
    });
    await writeAudit(tx, {
      shipmentId: shipment.id,
      shipmentRef: shipment.ref,
      action: "APPROVAL_REVOKED",
      actorId: actor.id,
      actorName: actor.name,
      payload: { reason: "HUMAN_WRITE" },
    });
  } else if (t.next !== shipment.status) {
    await tx.shipment.update({ where: { id: shipment.id }, data: { status: t.next } });
  }
  return t.next;
}

export async function patchField(
  user: AuthUser,
  shipmentId: string,
  fieldId: string,
  dto: PatchFieldInput,
) {
  return prisma.$transaction(async (tx) => {
    const field = await tx.extractedField.findFirst({ where: { id: fieldId, shipmentId } });
    if (!field) throw new ApiError("NOT_FOUND", "Field not found", { fieldId });
    const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });

    // Confirm-as-extracted (value absent): idempotent by design — confirming
    // twice is harmless and audited ONCE (file 04 row-12 note).
    if (dto.value === undefined) {
      if (field.status === "CONFIRMED") {
        return { field, status: shipment.status as ShipmentStatus, recomputed: false };
      }
      const updated = await tx.extractedField.update({
        where: { id: field.id },
        data: { status: "CONFIRMED", confirmedById: user.id, confirmedAt: new Date() },
      });
      const preStatus = await applyHumanWrite(tx, shipment, user);
      await writeAudit(tx, {
        shipmentId,
        shipmentRef: shipment.ref,
        action: "FIELD_CONFIRMED",
        actorId: user.id,
        actorName: user.name,
        payload: { fieldKey: field.fieldKey, fieldId: field.id },
      });
      const rec = await recomputeInTx(tx, { ...shipment, status: preStatus }, user);
      return { field: updated, status: rec.status, recomputed: true };
    }

    // Correction (value present): parse by the field dictionary's kind → 422 on garbage.
    if (!isFieldKey(field.fieldKey)) {
      throw new ApiError("UNPROCESSABLE", "Unknown fieldKey cannot be corrected", { fieldKey: field.fieldKey });
    }
    const columns = parseCorrection(field.fieldKey, { currency: field.currency }, dto.value);
    const updated = await tx.extractedField.update({
      where: { id: field.id },
      data: {
        ...columns,
        status: "CORRECTED",
        confirmedById: user.id,
        confirmedAt: new Date(),
        isUnreadable: false,
      },
    });
    const preStatus = await applyHumanWrite(tx, shipment, user);
    await writeAudit(tx, {
      shipmentId,
      shipmentRef: shipment.ref,
      action: "FIELD_CORRECTED",
      actorId: user.id,
      actorName: user.name,
      payload: {
        fieldKey: field.fieldKey,
        fieldId: field.id,
        from: field.valueText ?? field.valueNumeric?.toString() ?? field.valueDate?.toISOString() ?? null,
        to: dto.value,
      },
    });
    const rec = await recomputeInTx(tx, { ...shipment, status: preStatus }, user);
    return { field: updated, status: rec.status, recomputed: true };
  });
}

export async function manualEntry(user: AuthUser, documentId: string, dto: ManualEntryInput) {
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.findUnique({ where: { id: documentId }, include: { shipment: true } });
    if (!doc) throw new ApiError("NOT_FOUND", "Document not found", { documentId });
    const shipment = doc.shipment;

    await applyHumanWrite(tx, shipment, user); // manual entry is a human write (409 when EXPORTED)

    const written: string[] = [];
    for (const f of dto.fields) {
      const existing = await tx.extractedField.findUnique({
        where: { documentId_fieldKey: { documentId, fieldKey: f.fieldKey } },
      });
      const columns: CorrectionColumns =
        existing && isFieldKey(f.fieldKey)
          ? parseCorrection(f.fieldKey, { currency: existing.currency }, f.value)
          : { valueText: f.value };
      const data = {
        ...columns,
        status: "MANUAL_ENTERED" as const,
        confidence: null, // manual entry has no confidence (file 04 §2)
        confirmedById: user.id,
        confirmedAt: new Date(),
        isUnreadable: false,
      };
      await tx.extractedField.upsert({
        where: { documentId_fieldKey: { documentId, fieldKey: f.fieldKey } },
        create: { shipmentId: doc.shipmentId, documentId, fieldKey: f.fieldKey, ...data },
        update: data,
      });
      written.push(f.fieldKey);
    }
    for (const li of dto.lineItems ?? []) {
      const qtyMilli = Math.round(li.quantity * 1000);
      const priceMilli = li.unitPrice === undefined ? null : Math.round(li.unitPrice * 1000);
      const lineTotal =
        priceMilli === null ? null : Number((BigInt(qtyMilli) * BigInt(priceMilli)) / 1_000_000n);
      await tx.lineItem.upsert({
        where: { documentId_seq: { documentId, seq: li.seq } },
        create: {
          shipmentId: doc.shipmentId,
          documentId,
          seq: li.seq,
          description: li.description,
          hsnCode: li.hsnCode,
          unit: li.unit,
          quantity: qtyMilli / 1000,
          unitPrice: priceMilli === null ? null : priceMilli / 1000,
          lineTotal,
        },
        update: {
          description: li.description,
          hsnCode: li.hsnCode,
          unit: li.unit,
          quantity: qtyMilli / 1000,
          unitPrice: priceMilli === null ? null : priceMilli / 1000,
          lineTotal,
        },
      });
    }

    await writeAudit(tx, {
      shipmentId: doc.shipmentId,
      shipmentRef: doc.shipment.ref,
      action: "MANUAL_ENTRY",
      actorId: user.id,
      actorName: user.name,
      payload: { documentId, fieldKeys: written, lineItems: (dto.lineItems ?? []).length },
    });
    const { status } = await recomputeInTx(tx, { id: shipment.id, ref: shipment.ref, status: shipment.status as ShipmentStatus }, user);
    return { status, written };
  });
}

export async function resolveCheck(user: AuthUser, shipmentId: string, checkId: string, dto: ResolveCheckInput) {
  return prisma.$transaction(async (tx) => {
    const check = await tx.crossCheck.findFirst({ where: { id: checkId, shipmentId } });
    if (!check) throw new ApiError("NOT_FOUND", "Check not found", { checkId });
    if (check.result !== "FAIL" || check.severity !== "BLOCKING") {
      throw new ApiError("UNPROCESSABLE", "Only BLOCKING FAIL checks can be resolved", {
        ruleKey: check.ruleKey,
        result: check.result,
      });
    }
    if (check.resolvedAt) return { check, status: null, recomputed: false }; // idempotent

    const updated = await tx.crossCheck.update({
      where: { id: check.id },
      data: { resolvedById: user.id, resolvedNote: dto.note, resolvedAt: new Date() },
    });
    await writeAudit(tx, {
      shipmentId,
      shipmentRef: (await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).ref,
      action: "DISCREPANCY_RESOLVED",
      actorId: user.id,
      actorName: user.name,
      payload: { ruleKey: check.ruleKey, note: dto.note },
    });
    const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    const { status } = await recomputeInTx(
      tx,
      { id: shipment.id, ref: shipment.ref, status: shipment.status as ShipmentStatus },
      user,
    );
    return { check: updated, status, recomputed: true };
  });
}
