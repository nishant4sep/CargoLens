/**
 * Contract row 8 — POST /api/shipments/:id/documents — multipart {file, type}.
 *
 * Upload safety (06 §1.3): size asserted BEFORE buffering (413), physical type
 * by magic bytes (never browser MIME claims), per-type uniqueness (409 — a
 * duplicate upload is a real-constraint conflict), randomized storage name
 * (no user-provided string joins a path), sha256 stored, storage-write FIRST
 * then row+audit in one transaction with orphan cleanup on failure.
 */
import { NextResponse } from "next/server";
import { ApiError, getSessionUser, toErrorResponse } from "@/server/http";
import { prisma } from "@/lib/prisma";
import { requireShipment } from "@/server/services/shipments";
import { writeAudit } from "@/server/services/audit";
import { putDocument, removeDocument } from "@/server/storage";

type Ctx = { params: Promise<{ id: string }> };

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB, asserted before any buffering/write
const DOC_TYPES = ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"] as const;
type DocType = (typeof DOC_TYPES)[number];

/** Magic-byte sniff — the ONLY type claim we trust (06 §1.3). */
function sniffMime(head: Buffer): string {
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return "image/png";
  }
  throw new ApiError("VALIDATION_ERROR", "File is not a PDF, JPEG or PNG (verified by content, not file name)");
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await getSessionUser(req);
    if (!user) throw new ApiError("UNAUTHENTICATED", "Sign in required");
    const { id } = await ctx.params;
    const shipment = await requireShipment(id); // 404
    // The state machine's own docstring: EXPORTED is terminal — no field or
    // DOCUMENT writes afterwards. Enforced here so the storage seam can never
    // become a side door around the machine (06 §1.3 write-path discipline).
    if (shipment.status === "EXPORTED") {
      throw new ApiError("CONFLICT", "Shipment is exported; documents can no longer change", { status: shipment.status });
    }

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new ApiError("VALIDATION_ERROR", "Expected multipart/form-data with file and type fields");
    }
    // Fast pre-gate on the declared size (cheap, spoofable — the real gate is file.size).
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES * 2) {
      throw new ApiError("VALIDATION_ERROR", `File exceeds the 10 MB limit`, { maxBytes: MAX_BYTES }, 413);
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ApiError("VALIDATION_ERROR", "Malformed multipart body");
    }
    const type = form.get("type");
    const file = form.get("file");
    if (typeof type !== "string" || !DOC_TYPES.includes(type as DocType)) {
      throw new ApiError("VALIDATION_ERROR", `type must be one of ${DOC_TYPES.join(", ")}`, { type });
    }
    if (!(file instanceof File) || file.size === 0) {
      throw new ApiError("VALIDATION_ERROR", "file field is required");
    }
    if (file.size > MAX_BYTES) {
      throw new ApiError("VALIDATION_ERROR", "File exceeds the 10 MB limit", { maxBytes: MAX_BYTES, gotBytes: file.size }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = sniffMime(buffer.subarray(0, 8));

    // Per-type uniqueness — a REAL constraint answers before any write happens.
    const existing = await prisma.document.findUnique({
      where: { shipmentId_type: { shipmentId: id, type: type as DocType } },
      select: { id: true },
    });
    if (existing) {
      throw new ApiError("CONFLICT", `A ${type} document already exists for this shipment`, { documentId: existing.id, type });
    }

    // Storage write FIRST, then row+audit in ONE transaction; on failure the
    // written file is removed (no orphans) — 03 §3.1's documented order.
    const stored = await putDocument(buffer);
    try {
      const document = await prisma.$transaction(async (tx) => {
        const d = await tx.document.create({
          data: {
            shipmentId: id,
            type: type as DocType,
            status: "UPLOADED",
            storagePath: stored.storagePath,
            fileName: file.name,
            mimeType,
            sizeBytes: stored.sizeBytes,
            sha256Hex: stored.sha256Hex,
            extractedAt: null, // extraction is Phase 5
            uploadedById: user.id,
          },
        });
        await writeAudit(tx, {
          shipmentId: id,
          shipmentRef: shipment.ref,
          action: "DOCUMENT_UPLOADED",
          actorId: user.id,
          actorName: user.name,
          payload: { documentId: d.id, type, sha256Hex: stored.sha256Hex, sizeBytes: Number(stored.sizeBytes) },
        });
        return d;
      });
      // Same deliberate serialization as the detail endpoint (BigInt never crosses JSON).
      return NextResponse.json(
        {
          document: {
            id: document.id,
            type: document.type,
            status: document.status,
            fileName: document.fileName,
            mimeType: document.mimeType,
            sizeBytes: document.sizeBytes.toString(),
            pageCount: document.pageCount,
            extractedAt: document.extractedAt,
          },
        },
        { status: 201 },
      );
    } catch (e) {
      await removeDocument(stored.storagePath);
      throw e;
    }
  } catch (e) {
    return toErrorResponse(e);
  }
}
