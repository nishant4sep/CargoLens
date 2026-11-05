/** Shipment list/create/detail/patch (contract rows 4–7). */
import { ApiError } from "@/server/http";
import { writeAudit } from "./audit";
import { prisma } from "@/lib/prisma";
import type {
  CreateShipmentInput,
  ListShipmentsInput,
  PatchShipmentInput,
} from "@/server/dto";
import type { AuthUser } from "@/server/http";

const PAGE_SIZE = 20;

export async function listShipments(dto: ListShipmentsInput) {
  const where = {
    ...(dto.status ? { status: dto.status } : {}),
    ...(dto.q ? { ref: { contains: dto.q } } : {}),
    ...(dto.supplier
      ? {
          supplier: {
            is: { OR: [{ name: { contains: dto.supplier } }, { id: dto.supplier }] },
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (dto.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        ref: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        supplier: { select: { id: true, name: true, country: true } },
        _count: { select: { documents: true, checks: true } },
      },
    }),
    prisma.shipment.count({ where }),
  ]);

  // Dashboard needs the blocking-discrepancy count per row (PRD screen 2's
  // unresolved ⚠). One groupBy over the page's shipments — no N+1 — merged
  // into the items additively (rows 4 contract: {items,page,total,hasMore}).
  const ids = items.map((i) => i.id);
  const blocking = ids.length
    ? await prisma.crossCheck.groupBy({
        by: ["shipmentId"],
        where: { shipmentId: { in: ids }, result: "FAIL", severity: "BLOCKING", resolvedAt: null },
        _count: { _all: true },
      })
    : [];
  const blockingByShipment = new Map(blocking.map((b) => [b.shipmentId, b._count._all]));

  return {
    items: items.map((i) => ({ ...i, blockingFails: blockingByShipment.get(i.id) ?? 0 })),
    page: dto.page,
    total,
    hasMore: dto.page * PAGE_SIZE < total,
  };
}

export async function createShipment(user: AuthUser, dto: CreateShipmentInput) {
  const now = new Date();
  const prefix = `SHP-${String(now.getUTCFullYear()).padStart(4, "0")}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  // Atomic "count+1" ref in the same tx as the create (file 04 §2: the product
  // has no deletes, so COUNT is monotonic and max+1 == count+1).
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        let supplierId: string | null = null;
        if (dto.supplierName) {
          const supplier = await tx.supplier.upsert({
            where: { name: dto.supplierName },
            create: { name: dto.supplierName, country: dto.supplierCountry ?? null },
            update: {},
          });
          supplierId = supplier.id;
        }
        const seq = (await tx.shipment.count({ where: { ref: { startsWith: prefix } } })) + 1;
        const ref = `${prefix}-${String(seq).padStart(2, "0")}`;
        const shipment = await tx.shipment.create({
          data: { ref, supplierId, createdById: user.id },
          include: { supplier: { select: { id: true, name: true, country: true } } },
        });
        await writeAudit(tx, {
          shipmentId: shipment.id,
          shipmentRef: ref,
          action: "SHIPMENT_CREATED",
          actorId: user.id,
          actorName: user.name,
          payload: { ref, supplierId, source: "api" },
        });
        return shipment;
      });
    } catch (e) {
      // Unique-ref race between two concurrent creates: retry with a fresh count.
      const isUniqueRace =
        e instanceof Object && "code" in e && (e as { code: string }).code === "P2002";
      if (!isUniqueRace || attempt >= 3) throw e;
    }
  }
}

export async function getShipmentDetail(id: string) {
  const s = await prisma.shipment.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, name: true, country: true } },
      approvedBy: { select: { name: true } },
      documents: {
        orderBy: { type: "asc" },
        include: {
          fields: { orderBy: { fieldKey: "asc" } },
          lineItems: { orderBy: { seq: "asc" } },
        },
      },
      checks: { orderBy: { ruleKey: "asc" } },
    },
  });
  if (!s) return null;
  const latestExport = await prisma.exportRecord.findFirst({
    where: { shipmentId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, fileName: true, formatVersion: true, csvSha256: true, createdAt: true },
  });

  const fields = s.documents.flatMap((d) => d.fields);
  const blockingFails = s.checks.filter(
    (c) => c.result === "FAIL" && c.severity === "BLOCKING" && c.resolvedAt === null,
  ).length;

  // BigInt (sizeBytes) never crosses JSON — serialize deliberately.
  const documents = s.documents.map((d) => ({
    id: d.id,
    type: d.type,
    status: d.status,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes.toString(),
    pageCount: d.pageCount,
    extractedAt: d.extractedAt,
  }));

  return {
    shipment: {
      id: s.id,
      ref: s.ref,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      supplier: s.supplier,
      approval: s.approvedById
        ? { approvedById: s.approvedById, approvedByName: s.approvedBy?.name ?? null, approvedAt: s.approvedAt }
        : null,
    },
    documents,
    fields: s.documents.flatMap((d) => d.fields.map((f) => ({ ...f, documentType: d.type }))),
    lineItems: s.documents.flatMap((d) => d.lineItems.map((li) => ({ ...li, documentType: d.type }))),
    checks: s.checks,
    latestExport,
    metrics: {
      documentsCount: s.documents.length,
      fieldsTotal: fields.length,
      fieldsCleared: fields.filter((f) => f.status !== "AI_DRAFT").length,
      unresolvedBlockingFails: blockingFails,
    },
  };
}

export async function patchShipment(user: AuthUser, id: string, dto: PatchShipmentInput) {
  const supplier = await prisma.supplier.findUnique({ where: { id: dto.supplierId } });
  if (!supplier) throw new ApiError("NOT_FOUND", "Supplier not found", { supplierId: dto.supplierId });
  const shipment = await prisma.shipment.findUnique({ where: { id } });
  if (!shipment) throw new ApiError("NOT_FOUND", "Shipment not found");
  return prisma.shipment.update({
    where: { id },
    data: { supplierId: supplier.id },
    include: { supplier: { select: { id: true, name: true, country: true } } },
  });
}

/** Shared 404 helper for routes that address a shipment by id. */
export async function requireShipment(id: string) {
  const s = await prisma.shipment.findUnique({ where: { id } });
  if (!s) throw new ApiError("NOT_FOUND", "Shipment not found", { shipmentId: id });
  return s;
}
