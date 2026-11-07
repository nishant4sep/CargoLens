/**
 * AI extraction orchestration (Phase 5, contract row 9 — file 05 §2 steps 2–8).
 *
 * Pipeline: claim (state-machine audited) → provider bytes → schema (one repair
 * retry) → normalize via the EXISTING parseCorrection → persist an AI_DRAFT
 * layer that NEVER touches human work → document terminal status → the SAME
 * terminal-count/DOCS_REACHED_TERMINAL/recompute logic manual entry uses.
 *
 * Trust rules enforced here:
 *  - the provider is called OUTSIDE any transaction (long I/O); persistence is
 *    ONE transaction (all-or-nothing per document) — a crash mid-provider-call
 *    leaves PROCESSING + extractError recoverable by the 15-minute zombie guard
 *    or by manual entry, never a zombie success;
 *  - the AI layer of a document is REPLACED wholesale on each run (stale
 *    AI_DRAFT rows for absent keys are deleted); rows with a human status
 *    (CONFIRMED/CORRECTED/MANUAL_ENTERED) are untouchable by construction;
 *  - per-cell values that fail the normalizer are NOT guessed into the DB —
 *    they are reported in the audit + response, and REQUIRED_FIELDS flags the gap;
 *  - failures are handled OUTCOMES (document FAILED + audited + retryable),
 *    not hidden errors;
 *  - the provider name lands in every audit payload — stub runs can never
 *    masquerade as AI runs.
 */
import { ApiError, type AuthUser } from "@/server/http";
import { prisma } from "@/lib/prisma";
import { transition, type ShipmentStatus } from "@/server/engines/state-machine";
import { parseAmountToMilli } from "@/server/engines/normalize";
import { FIELD_KINDS, isFieldKey, type FieldKey } from "@/lib/types";
import {
  ProviderError,
  ProviderUnavailableError,
  RawExtractionSchema,
  getProvider,
  type ExtractInput,
  type ExtractionProvider,
  type RawExtraction,
} from "@/server/ai/provider";
import { openDocument } from "@/server/storage";
import { parseCorrection, type CorrectionColumns } from "./snapshots";
import { recomputeInTx } from "./review";
import { writeAudit } from "./audit";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** A doc stuck in PROCESSING longer than this is a crashed run — re-runnable. */
const STALE_PROCESSING_MS = 15 * 60 * 1000;

interface ExtractionOutcome {
  provider: string;
  documentUnreadable: boolean;
  fieldsWritten: string[];
  fieldsSkippedHuman: string[];
  fieldsInvalid: Array<{ fieldKey: string; value: string; reason: string }>;
  lineItemsWritten: number;
  linesSkippedHuman: boolean;
}

function serializeDocument(d: {
  id: string;
  type: string;
  status: string;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  pageCount: number | null;
  extractedAt: Date | null;
  extractError: string | null;
}) {
  return {
    id: d.id,
    type: d.type,
    status: d.status,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes.toString(),
    pageCount: d.pageCount,
    extractedAt: d.extractedAt,
    extractError: d.extractError,
  };
}

/** The machine's own EXTRACTION_STARTED chain to PROCESSING. PROCESSING is
 *  skipped (extraction mid-phase needs no new event — the manual entry
 *  precedent); EXPORTED fails with 409; APPROVED passes through its revoke hop. */
async function claimForExtraction(
  shipment: { id: string; ref: string; status: string },
  providerName: string,
  documentId: string,
) {
  let status = shipment.status as ShipmentStatus;
  if (status === "PROCESSING") return status;
  for (let hop = 0; hop < 3 && status !== "PROCESSING"; hop++) {
    const t = transition(status, { type: "EXTRACTION_STARTED" });
    if (!t.ok) throw new ApiError("CONFLICT", `Cannot extract: ${t.reason}`, { status: shipment.status });
    await prisma.$transaction(async (tx) => {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: t.next,
          ...(t.approvalRevoked ? { approvedById: null, approvedAt: null } : {}),
        },
      });
      if (t.approvalRevoked) {
        await writeAudit(tx, {
          shipmentId: shipment.id,
          shipmentRef: shipment.ref,
          action: "APPROVAL_REVOKED",
          actorId: undefined,
          actorName: "Extraction (AI re-run)",
          payload: { reason: "EXTRACTION" },
        });
      }
      await writeAudit(tx, {
        shipmentId: shipment.id,
        shipmentRef: shipment.ref,
        action: "EXTRACTION_STARTED",
        actorId: undefined,
        actorName: "Extraction (system)",
        payload: { via: "AI", provider: providerName, documentId },
      });
    });
    status = t.next;
  }
  return status;
}

/** Terminal-count + DOCS_REACHED_TERMINAL + recompute — the EXACT D-1b ladder
 *  (review.ts manualEntry), shared by the success/unreadable/failure paths. */
async function finishInTx(
  tx: Tx,
  shipment: { id: string; ref: string },
  status: ShipmentStatus,
  user: AuthUser,
): Promise<ShipmentStatus> {
  let current = status;
  if (current === "PROCESSING") {
    const [total, terminal] = await Promise.all([
      tx.document.count({ where: { shipmentId: shipment.id } }),
      tx.document.count({
        where: { shipmentId: shipment.id, status: { in: ["PROCESSED", "UNREADABLE", "FAILED"] } },
      }),
    ]);
    if (total > 0 && terminal === total) {
      const done = transition("PROCESSING", { type: "DOCS_REACHED_TERMINAL" });
      if (!done.ok) throw new ApiError("CONFLICT", done.reason, { status });
      await tx.shipment.update({ where: { id: shipment.id }, data: { status: done.next } });
      await writeAudit(tx, {
        shipmentId: shipment.id,
        shipmentRef: shipment.ref,
        action: "DOCS_REACHED_TERMINAL",
        actorId: user.id,
        actorName: user.name,
        payload: { via: "AI", documents: total },
      });
      current = done.next;
    }
  }
  const rec = await recomputeInTx(tx, { id: shipment.id, ref: shipment.ref, status: current }, user);
  return rec.status;
}

export async function extractDocument(user: AuthUser, documentId: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, include: { shipment: true } });
  if (!doc) throw new ApiError("NOT_FOUND", "Document not found", { documentId });
  const shipment = doc.shipment;

  // Config BEFORE any state changes — a missing key costs nothing and changes
  // nothing. The seam owns "is a provider configured" (single source of truth:
  // a stub run needs no key; every real path needs GEMINI_API_KEY).
  let provider: ExtractionProvider;
  try {
    provider = getProvider();
  } catch (e) {
    if (e instanceof ProviderUnavailableError) {
      throw new ApiError(
        "PROVIDER_UNAVAILABLE",
        "No AI provider is configured (GEMINI_API_KEY is not set). Extraction is blocked; manual entry remains available.",
        undefined,
        503,
      );
    }
    throw e;
  }

  if (doc.status === "PROCESSING" && Date.now() - doc.updatedAt.getTime() < STALE_PROCESSING_MS) {
    throw new ApiError("CONFLICT", "Extraction is already in progress for this document", {
      documentId,
      status: doc.status,
    });
  }

  const bytes = await openDocument(doc.storagePath);
  if (!bytes) {
    throw new ApiError("CONFLICT", "Document bytes are missing from private storage — the file must be re-uploaded", {
      documentId,
    });
  }

  // Claim: machine-audited move to PROCESSING (shipment + this document).
  const status = await claimForExtraction(shipment, provider.name, doc.id);
  await prisma.document.update({ where: { id: doc.id }, data: { status: "PROCESSING", extractError: null } });

  const input: ExtractInput = { bytes, mimeType: doc.mimeType, docType: doc.type };

  // Provider + schema with ONE repair retry (file 05 §5) — failures are outcomes.
  let raw: RawExtraction | null = null;
  let failure: string | null = null;
  try {
    const first = RawExtractionSchema.safeParse(await provider.extract(input));
    if (first.success) {
      raw = first.data;
    } else {
      const issues = first.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
        .slice(0, 300);
      const repaired = RawExtractionSchema.safeParse(await provider.extract({ ...input, repairNote: issues }));
      if (repaired.success) raw = repaired.data;
      else failure = `Structured output failed schema validation twice (${issues})`;
    }
  } catch (e) {
    failure = e instanceof ProviderError ? e.message : `Provider failed: ${e instanceof Error ? e.message : "unknown"}`;
  }

  if (raw === null) {
    // FAILED is a terminal, RETRYABLE document status — never a zombie.
    return prisma.$transaction(async (tx) => {
      const failed = await tx.document.update({
        where: { id: doc.id },
        data: { status: "FAILED", extractError: failure!.slice(0, 500) },
      });
      await writeAudit(tx, {
        shipmentId: shipment.id,
        shipmentRef: shipment.ref,
        action: "EXTRACTION_FAILED",
        actorId: user.id,
        actorName: user.name,
        payload: { via: "AI", provider: provider.name, documentId: doc.id, error: failure!.slice(0, 300) },
      });
      const finalStatus = await finishInTx(tx, shipment, status, user);
      return { document: serializeDocument(failed), shipmentStatus: finalStatus, extraction: null };
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    const outcome: ExtractionOutcome = {
      provider: provider.name,
      documentUnreadable: raw!.documentUnreadable,
      fieldsWritten: [],
      fieldsSkippedHuman: [],
      fieldsInvalid: [],
      lineItemsWritten: 0,
      linesSkippedHuman: false,
    };

    if (raw!.documentUnreadable) {
      // Whole-document UNREADABLE is a TERMINAL status: the manual-entry path
      // completes this document (the brief's own rule) — extraction is done.
      const unreadable = await tx.document.update({
        where: { id: doc.id },
        data: { status: "UNREADABLE", extractedAt: doc.extractedAt ?? new Date(), extractError: raw!.unreadableReason?.slice(0, 500) ?? null },
      });
      await writeAudit(tx, {
        shipmentId: shipment.id,
        shipmentRef: shipment.ref,
        action: "EXTRACTION_COMPLETED",
        actorId: user.id,
        actorName: user.name,
        payload: { via: "AI", provider: outcome.provider, documentId: doc.id, documentUnreadable: true, reason: raw!.unreadableReason },
      });
      const finalStatus = await finishInTx(tx, shipment, status, user);
      return { document: serializeDocument(unreadable), shipmentStatus: finalStatus, extraction: outcome };
    }

    // The AI layer is replaced wholesale: stale AI_DRAFT rows for keys this run
    // does not mention are gone; human-status rows are structurally untouchable.
    const touchedKeys = raw!.fields.map((f) => f.fieldKey as string);
    await tx.extractedField.deleteMany({
      where: { documentId: doc.id, status: "AI_DRAFT", fieldKey: { notIn: touchedKeys } },
    });

    // MONEY fields carry the document's own currency (the extraction's currency
    // field), matching the seed's typed-column convention.
    const docCurrency = raw!.fields.find((f) => f.fieldKey === "currency" && !f.unreadable && f.value)?.value?.trim().toUpperCase() ?? null;

    for (const f of raw!.fields) {
      const existing = await tx.extractedField.findUnique({
        where: { documentId_fieldKey: { documentId: doc.id, fieldKey: f.fieldKey } },
      });
      if (existing && existing.status !== "AI_DRAFT") {
        outcome.fieldsSkippedHuman.push(f.fieldKey); // NEVER overwrite human work
        continue;
      }
      if (f.unreadable || f.value === null) {
        if (!f.unreadable) continue; // absent on the page → no row; REQUIRED_FIELDS reports it
        const data = {
          isUnreadable: true,
          valueText: null,
          valueNumeric: null,
          valueDate: null,
          status: "AI_DRAFT" as const,
          confidence: f.confidence,
          sourcePage: f.page,
          sourceExcerpt: f.excerpt,
          confirmedById: null,
          confirmedAt: null,
        };
        await tx.extractedField.upsert({
          where: { documentId_fieldKey: { documentId: doc.id, fieldKey: f.fieldKey } },
          create: { shipmentId: shipment.id, documentId: doc.id, fieldKey: f.fieldKey, ...data },
          update: data,
        });
        outcome.fieldsWritten.push(f.fieldKey);
        continue;
      }
      try {
        if (!isFieldKey(f.fieldKey)) throw new ApiError("UNPROCESSABLE", "Unknown field key"); // Zod enum already guarantees this
        const kind = FIELD_KINDS[f.fieldKey];
        const columns: CorrectionColumns = parseCorrection(
          f.fieldKey,
          { currency: existing?.currency ?? (kind === "MONEY" ? docCurrency : null) },
          f.value,
        );
        const data = {
          ...columns,
          isUnreadable: false,
          status: "AI_DRAFT" as const,
          confidence: f.confidence,
          sourcePage: f.page,
          sourceExcerpt: f.excerpt,
          confirmedById: null,
          confirmedAt: null,
        };
        await tx.extractedField.upsert({
          where: { documentId_fieldKey: { documentId: doc.id, fieldKey: f.fieldKey } },
          create: { shipmentId: shipment.id, documentId: doc.id, fieldKey: f.fieldKey, ...data },
          update: data,
        });
        outcome.fieldsWritten.push(f.fieldKey);
      } catch (e) {
        if (e instanceof ApiError && e.code === "UNPROCESSABLE") {
          outcome.fieldsInvalid.push({ fieldKey: f.fieldKey, value: f.value, reason: e.message }); // reported, never guessed
        } else throw e;
      }
    }

    // Lines are the AI's only when the document was never hand-entered
    // (MANUAL_ENTERED fields ⇒ the human owns this document's lines).
    const humanEntered =
      (await tx.extractedField.count({ where: { documentId: doc.id, status: "MANUAL_ENTERED" } })) > 0;
    outcome.linesSkippedHuman = humanEntered;
    if (!humanEntered && raw!.lineItems.length > 0) {
      await tx.lineItem.deleteMany({ where: { documentId: doc.id } });
      const seenSeqs = new Set<number>(); // @@unique([documentId, seq]) — a duplicate must not 500 the run
      for (const li of raw!.lineItems) {
        if (seenSeqs.has(li.seq)) {
          outcome.fieldsInvalid.push({ fieldKey: `lineItem#${li.seq}`, value: li.description, reason: "Duplicate seq — line skipped" });
          continue;
        }
        seenSeqs.add(li.seq);
        const qtyMilli = li.qty === null ? null : parseAmountToMilli(li.qty);
        if (qtyMilli === null) {
          outcome.fieldsInvalid.push({ fieldKey: `lineItem#${li.seq}.qty`, value: li.qty ?? "", reason: "Unparseable quantity — line skipped" });
          continue; // quantity is NOT NULL in the schema — an unparseable line cannot be stored
        }
        const priceMilli = li.unitPrice === null ? null : parseAmountToMilli(li.unitPrice);
        const totalMilli = li.lineTotal === null ? null : parseAmountToMilli(li.lineTotal);
        await tx.lineItem.create({
          data: {
            shipmentId: shipment.id,
            documentId: doc.id,
            seq: li.seq,
            description: li.description,
            hsnCode: li.hsnCode,
            unit: li.unit,
            quantity: qtyMilli / 1000,
            unitPrice: priceMilli === null ? null : priceMilli / 1000,
            lineTotal: totalMilli === null ? null : totalMilli / 1000,
          },
        });
        outcome.lineItemsWritten += 1;
      }
    }

    const processed = await tx.document.update({
      where: { id: doc.id },
      data: { status: "PROCESSED", extractedAt: doc.extractedAt ?? new Date(), extractError: null },
    });
    await writeAudit(tx, {
      shipmentId: shipment.id,
      shipmentRef: shipment.ref,
      action: "EXTRACTION_COMPLETED",
      actorId: user.id,
      actorName: user.name,
      payload: {
        via: "AI",
        provider: outcome.provider,
        documentId: doc.id,
        fieldsWritten: outcome.fieldsWritten.length,
        fieldsSkippedHuman: outcome.fieldsSkippedHuman.length,
        fieldsInvalid: outcome.fieldsInvalid.length,
        lineItems: outcome.lineItemsWritten,
      },
    });
    const finalStatus = await finishInTx(tx, shipment, status, user);
    return { document: serializeDocument(processed), shipmentStatus: finalStatus, extraction: outcome };
  });

  return result;
}
