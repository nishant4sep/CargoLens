/** Accuracy report (contract row 19) — plain SQL group-bys over field rows. */
import { prisma } from "@/lib/prisma";

export async function accuracyByField() {
  const [byKeyStatus, byKeyAll] = await Promise.all([
    prisma.extractedField.groupBy({
      by: ["fieldKey", "status"],
      _count: { _all: true },
    }),
    prisma.extractedField.groupBy({
      by: ["fieldKey"],
      _avg: { confidence: true },
      _count: { _all: true },
    }),
  ]);
  const rows = byKeyAll.map((k) => {
    const countFor = (status: string) =>
      byKeyStatus.find((s) => s.fieldKey === k.fieldKey && s.status === status)?._count._all ?? 0;
    return {
      fieldKey: k.fieldKey,
      total: k._count._all,
      aiDraft: countFor("AI_DRAFT"),
      confirmed: countFor("CONFIRMED") + countFor("CORRECTED") + countFor("MANUAL_ENTERED"),
      corrected: countFor("CORRECTED"),
      manualEntered: countFor("MANUAL_ENTERED"),
      avgConfidence: k._avg.confidence ? k._avg.confidence.toString() : null,
    };
  });
  rows.sort((a, b) => b.total - a.total || a.fieldKey.localeCompare(b.fieldKey));
  return { groupBy: "field" as const, rows };
}

export async function accuracyBySupplier() {
  const [byShipmentStatus, byShipmentAll, shipments] = await Promise.all([
    prisma.extractedField.groupBy({
      by: ["shipmentId", "status"],
      _count: { _all: true },
    }),
    prisma.extractedField.groupBy({
      by: ["shipmentId"],
      _avg: { confidence: true },
      _count: { _all: true },
    }),
    prisma.shipment.findMany({
      select: { id: true, supplier: { select: { id: true, name: true } } },
    }),
  ]);
  const supplierOf = new Map(shipments.map((s) => [s.id, s.supplier]));
  const rows = new Map<
    string | null,
    { supplierId: string | null; supplierName: string | null; shipments: Set<string>; fieldsTotal: number; cleared: number; confSum: number; confCount: number }
  >();
  const rowFor = (supplierId: string | null) => {
    let r = rows.get(supplierId);
    if (!r) {
      const sup = supplierId ? shipments.find((s) => s.supplier?.id === supplierId)?.supplier : null;
      r = {
        supplierId,
        supplierName: sup?.name ?? null,
        shipments: new Set(),
        fieldsTotal: 0,
        cleared: 0,
        confSum: 0,
        confCount: 0,
      };
      rows.set(supplierId, r);
    }
    return r;
  };
  for (const g of byShipmentAll) {
    const supplierId = supplierOf.get(g.shipmentId)?.id ?? null;
    const r = rowFor(supplierId);
    r.shipments.add(g.shipmentId);
    r.fieldsTotal += g._count._all;
    if (g._avg.confidence) {
      r.confSum += g._avg.confidence.toNumber() * g._count._all;
      r.confCount += g._count._all;
    }
  }
  for (const g of byShipmentStatus) {
    if (g.status === "AI_DRAFT") continue;
    const supplierId = supplierOf.get(g.shipmentId)?.id ?? null;
    rowFor(supplierId).cleared += g._count._all;
  }
  return {
    groupBy: "supplier" as const,
    rows: [...rows.values()]
      .map((r) => ({
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        shipments: r.shipments.size,
        fieldsTotal: r.fieldsTotal,
        fieldsCleared: r.cleared,
        avgConfidence: r.confCount === 0 ? null : String(Math.round((r.confSum / r.confCount) * 1000) / 1000),
      }))
      .sort((a, b) => b.fieldsTotal - a.fieldsTotal),
  };
}
