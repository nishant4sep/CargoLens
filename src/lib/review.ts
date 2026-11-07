/**
 * Pure review-screen helpers (P4.4) — the ENTIRE presentation logic of the
 * review UI: value formatting per field kind, confidence display, per-status
 * write permissions (derived from the state machine's OWN table — the UI can
 * never claim a permission the machine denies), and check-detail rendering
 * from the engine's detailsJson payloads (the client INVENTS nothing: rows it
 * cannot recognize render generically, never fabricated).
 *
 * Everything here is PURE and unit-tested; components stay dumb.
 */
import { DOC_TYPES, FIELD_KINDS, isFieldKey, type DocType, type FieldKey, type TypedFieldValue } from "@/lib/types";
import { documentTypeLabel, formatBytes } from "@/lib/format";
import { REQUIRED_FIELD_KEYS } from "@/server/engines/crosschecks";

/* --------------------------------- types --------------------------------- */

/** A field row exactly as the row-6 aggregate serves it (JSON: Decimals are
 *  strings, dates are ISO strings) — normalized for the UI. */
export interface ReviewField {
  id: string;
  documentId: string;
  documentType: DocType;
  fieldKey: string;
  kind: TypedFieldValue["kind"];
  text: string | null;
  numeric: string | null; // REAL units (DB stores 7650 for EUR 7,650.00)
  date: string | null; // ISO datetime
  currency: string | null;
  confidence: string | null; // "0.930"
  isUnreadable: boolean;
  status: string; // AI_DRAFT | CONFIRMED | CORRECTED | MANUAL_ENTERED
  sourcePage: number | null;
  sourceExcerpt: string | null;
}

/** Normalizes an aggregate/route field row (raw JSON) into a ReviewField. */
export function toReviewField(raw: Record<string, unknown>): ReviewField {
  const fieldKey = String(raw.fieldKey ?? "");
  return {
    id: String(raw.id),
    documentId: String(raw.documentId),
    documentType: raw.documentType as DocType,
    fieldKey,
    kind: isFieldKey(fieldKey) ? FIELD_KINDS[fieldKey] : "TEXT",
    text: (raw.valueText as string | null) ?? null,
    numeric: (raw.valueNumeric as string | null) ?? null,
    date: (raw.valueDate as string | null) ?? null,
    currency: (raw.currency as string | null) ?? null,
    confidence: (raw.confidence as string | null) ?? null,
    isUnreadable: Boolean(raw.isUnreadable),
    status: String(raw.status ?? "AI_DRAFT"),
    sourcePage: (raw.sourcePage as number | null) ?? null,
    sourceExcerpt: (raw.sourceExcerpt as string | null) ?? null,
  };
}

/* ------------------------------- formatting ------------------------------- */

const numberFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const moneyFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "EUR", // overridden per-call when the field carries a code
  maximumFractionDigits: 2,
});

function money(n: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(n);
    } catch {
      // unknown currency code — fall through to a plain grouped number
    }
  }
  return numberFmt.format(n);
}

/** Human display value for a field row; unreadable/degenerate input renders
 *  honestly (never a fabricated zero). */
export function formatFieldValue(f: Pick<ReviewField, "kind" | "text" | "numeric" | "date" | "currency" | "isUnreadable">): string {
  if (f.isUnreadable && f.text === null && f.numeric === null && f.date === null) return "Unreadable";
  switch (f.kind) {
    case "MONEY": {
      if (f.numeric === null) return "—";
      const n = Number(f.numeric);
      return Number.isFinite(n) ? money(n, f.currency) : "—";
    }
    case "WEIGHT_KG":
    case "QTY":
    case "COUNT": {
      if (f.numeric === null) return "—";
      const n = Number(f.numeric);
      return Number.isFinite(n) ? `${numberFmt.format(n)}${f.kind === "WEIGHT_KG" ? " kg" : ""}` : "—";
    }
    case "DATE": {
      if (!f.date) return "—";
      const d = new Date(f.date);
      return Number.isNaN(d.getTime())
        ? "—"
        : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
    }
    default:
      return f.text?.trim() ? f.text.trim() : "—";
  }
}

/** The canonical RAW string a correction input is prefilled with — chosen so
 *  the server's parseCorrection round-trips it exactly (no silent conversion). */
export function rawEditableValue(f: Pick<ReviewField, "kind" | "text" | "numeric" | "date">): string {
  switch (f.kind) {
    case "MONEY": {
      const n = Number(f.numeric);
      return f.numeric !== null && Number.isFinite(n) ? n.toFixed(2) : "";
    }
    case "WEIGHT_KG":
    case "QTY":
    case "COUNT":
      return f.numeric !== null && Number.isFinite(Number(f.numeric)) ? String(Number(f.numeric)) : "";
    case "DATE":
      return f.date ? f.date.slice(0, 10) : "";
    default:
      return f.text ?? "";
  }
}

/** "0.930" → "93%"; null → null (manual entries HAVE no confidence — the UI
 *  must not invent one). Malformed input → null. */
export function confidencePercent(confidence: string | null): string | null {
  if (confidence === null) return null;
  const n = Number(confidence);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return `${Math.round(n * 100)}%`;
}

/** The brief: uncertain values must be immediately noticeable. Below 0.90 the
 *  review row gets an amber treatment (AI confidence lives in [0,1]). */
export const LOW_CONFIDENCE_THRESHOLD = 0.9;

export function isLowConfidence(confidence: string | null): boolean {
  if (confidence === null) return false;
  const n = Number(confidence);
  return Number.isFinite(n) && n >= 0 && n < LOW_CONFIDENCE_THRESHOLD;
}

/* -------------------------------- labels ---------------------------------- */

const FIELD_LABELS: Record<string, string> = {
  supplierName: "Supplier name",
  supplierAddress: "Supplier address",
  supplierCountry: "Supplier country",
  consigneeName: "Consignee name",
  consigneeAddress: "Consignee address",
  invoiceNumber: "Invoice number",
  invoiceDate: "Invoice date",
  currency: "Currency",
  incoterm: "Incoterm",
  totalValue: "Total value",
  packagesCount: "Package count",
  packageType: "Package type",
  grossWeightKg: "Gross weight",
  netWeightKg: "Net weight",
  containerNumber: "Container number",
  bolNumber: "BOL number",
  vesselName: "Vessel name",
  portOfLoading: "Port of loading",
  portOfDischarge: "Port of discharge",
};

export function fieldLabel(fieldKey: string): string {
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

const FIELD_STATUS_LABELS: Record<string, string> = {
  AI_DRAFT: "AI draft",
  CONFIRMED: "Confirmed",
  CORRECTED: "Corrected",
  MANUAL_ENTERED: "Manually entered",
};

export function fieldStatusLabel(status: string): string {
  return FIELD_STATUS_LABELS[status] ?? status;
}

/* ------------------------- permissions (per status) ----------------------- */

export interface ReviewPermissions {
  /** confirm/correct a field — PATCH /fields/:id (HUMAN_WRITE) */
  canCorrect: boolean;
  /** manual entry — POST /documents/:id/manual (D-1b: it IS the extraction) */
  canManualEntry: boolean;
  /** accept-with-note a BLOCKING FAIL — POST /checks/:id/resolve */
  canResolve: boolean;
  /** the whole screen renders read-only with a banner */
  readOnly: boolean;
}

/** Derived STRICTLY from the machine's transition table (state-machine.ts):
 *  HUMAN_WRITE allowed in NEEDS_REVIEW (self-loop), READY (re-open), APPROVED
 *  (revocation); manual entry additionally legal in DRAFT (fires the machine's
 *  EXTRACTION_STARTED) and PROCESSING (D-1b: extraction in progress); resolve
 *  persists a row + recompute, so everywhere INVARIANTS_RECOMPUTED is legal
 *  except DRAFT (which the machine holds pre-extraction). EXPORTED: nothing. */
export function reviewPermissions(status: string): ReviewPermissions {
  switch (status) {
    case "DRAFT":
      return { canCorrect: false, canManualEntry: true, canResolve: false, readOnly: false };
    case "PROCESSING":
      return { canCorrect: false, canManualEntry: true, canResolve: true, readOnly: false };
    case "NEEDS_REVIEW":
      return { canCorrect: true, canManualEntry: true, canResolve: true, readOnly: false };
    case "READY_FOR_APPROVAL":
      return { canCorrect: true, canManualEntry: true, canResolve: true, readOnly: false };
    case "APPROVED":
      return { canCorrect: true, canManualEntry: true, canResolve: true, readOnly: false };
    case "EXPORTED":
      return { canCorrect: false, canManualEntry: false, canResolve: false, readOnly: true };
    default:
      return { canCorrect: false, canManualEntry: false, canResolve: false, readOnly: true };
  }
}

/* ---------------------- AI extraction action (Phase 5) --------------------- */

/** What the per-document "Extract with AI" action offers, derived STRICTLY
 *  from the row-9 service + the machine's own EXTRACTION_STARTED edges:
 *  UPLOADED/FAILED → extract (FAILED is retryable by design); PROCESSED/
 *  UNREADABLE → re-extract (the AI layer is replaceable, human rows are not);
 *  a PROCESSING document is a run in flight (the service 409s). Hidden on
 *  APPROVED/EXPORTED — re-extraction there would revoke/409, and revoking an
 *  approval is the approval panel's explicit job, not a side effect. The
 *  server remains the law; this only keeps impossible buttons off the screen. */
export function extractAction(shipmentStatus: string, docStatus: string): "extract" | "re-extract" | null {
  if (shipmentStatus === "APPROVED" || shipmentStatus === "EXPORTED") return null;
  switch (docStatus) {
    case "UPLOADED":
    case "FAILED":
      return "extract";
    case "PROCESSED":
    case "UNREADABLE":
      return "re-extract";
    default:
      return null; // document PROCESSING — a run is already in flight
  }
}

/* --------------------------- check display rows --------------------------- */

export interface CheckRow {
  label: string;
  value: string;
}

const gram = (g: number) => `${numberFmt.format(g / 1000)} kg`;
const milliMoney = (m: number, currency: string | null) => money(m / 1000, currency);

/** Renders a check's detailsJson into labeled expected/actual/difference rows —
 *  ONLY for payload shapes the engine actually emits (crosschecks.ts). Unknown
 *  rule keys fall back to generic key:value rows; nothing is invented. */
export function checkDetailRows(ruleKey: string, details: unknown, currency: string | null = null): CheckRow[] {
  if (details === null || typeof details !== "object") return [];
  const outer = details as Record<string, unknown>;
  // The persisted detailsJson is checkPayload's wrapper {details, failedRefs};
  // a raw engine result carries the payload directly. Accept both shapes —
  // the UI renders what the engine computed, never its own reconstruction.
  const d = (outer.details !== undefined && outer.details !== null ? (outer.details as Record<string, unknown>) : outer);
  switch (ruleKey) {
    case "REQUIRED_FIELDS":
      return Array.isArray(d.missing) && d.missing.length > 0
        ? [{ label: "Missing inputs", value: d.missing.filter((m): m is string => typeof m === "string").join("; ") }]
        : [];
    case "INVOICE_TOTAL":
      return [
        { label: "Line sum", value: milliMoney(Number(d.sumMilli), currency) },
        { label: "Invoice total", value: milliMoney(Number(d.totalMilli), currency) },
        { label: "Difference", value: milliMoney(Number(d.diffMilli), currency) },
      ];
    case "PACKAGES_MATCH":
      return [
        { label: "Packing list", value: numberFmt.format(Number(d.packingList)) },
        { label: "Bill of lading", value: numberFmt.format(Number(d.bol)) },
        { label: "Difference", value: numberFmt.format(Number(d.diff)) },
      ];
    case "GROSS_WEIGHT_CONSISTENCY": {
      const rows: CheckRow[] = [];
      if (Array.isArray(d.weights)) {
        for (const w of d.weights as Array<{ docType?: unknown; grams?: unknown }>) {
          if (typeof w.docType === "string" && typeof w.grams === "number") {
            rows.push({ label: `Weight · ${w.docType.replace(/_/g, " ").toLowerCase()}`, value: gram(w.grams) });
          }
        }
      }
      rows.push({ label: "Difference", value: gram(Number(d.diffGrams)) });
      rows.push({ label: "Tolerance", value: gram(Number(d.toleranceGrams)) });
      return rows;
    }
    case "CONTAINER_CONSISTENCY":
      return [
        { label: "Bill of lading", value: String(d.bol ?? "—") },
        { label: "Packing list", value: d.packingList === null || d.packingList === undefined ? "not provided" : String(d.packingList) },
        { label: "ISO 6346 form", value: d.iso6346Ok ? "yes" : "no" },
        { label: "Cross-document match", value: d.mismatch ? "MISMATCH" : "match" },
      ];
    default: {
      // Unknown-but-real engine payload: render its scalar entries generically.
      return Object.entries(d)
        .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
        .map(([k, v]) => ({ label: k, value: String(v) }));
    }
  }
}

const RULE_TITLES: Record<string, string> = {
  REQUIRED_FIELDS: "Required fields present",
  LINE_ARITHMETIC: "Line arithmetic (qty × price = total)",
  INVOICE_TOTAL: "Invoice total vs line sum",
  QUANTITY_MATCH: "Quantities: invoice vs packing list",
  PACKAGES_MATCH: "Package counts: packing list vs BOL",
  GROSS_WEIGHT_CONSISTENCY: "Gross weights across documents",
  NET_NOT_EXCEEDS_GROSS: "Net weight ≤ gross weight",
  CONTAINER_CONSISTENCY: "Container number consistency",
  CURRENCY_CONSISTENCY: "Currency consistency",
};

export function checkTitle(ruleKey: string): string {
  return RULE_TITLES[ruleKey] ?? ruleKey;
}

const CHECK_STATUS_LABELS: Record<string, string> = {
  PASS: "Pass",
  FAIL: "Fail",
  WARNING: "Warning",
  SKIPPED: "Skipped",
};

export function checkStatusLabel(status: string): string {
  return CHECK_STATUS_LABELS[status] ?? status;
}

/* ------------------- approval + export gates (P4.5) ----------------------- */

export type ViewerRole = "EXECUTIVE" | "MANAGER";

/** Derived STRICTLY from the machine's own table (state-machine.ts): the
 *  APPROVE event exists only from READY_FOR_APPROVAL, and the approve ROUTE
 *  additionally requires MANAGER (row 14 — 403 otherwise). The server is the
 *  truth; this only keeps a forbidden button off the screen. */
export function canApprove(status: string, role: ViewerRole): boolean {
  return role === "MANAGER" && status === "READY_FOR_APPROVAL";
}

/** The machine's EXPORT event exists only from APPROVED (ERR
 *  "PREMATURE_EXPORT"). NOTE (row 16 contract): the export ROUTE has NO role
 *  check — any signed-in user may export an APPROVED shipment. Deliberately
 *  NO role parameter here: inventing one would lie about the server. */
export function canExport(status: string): boolean {
  return status === "APPROVED";
}

/* --------------------- approval readiness summary ------------------------- */

/** What the approval panel displays, derived from the row-6 aggregate plus the
 *  engine's own required-field seam — a HUMAN summary, never a second gate:
 *  the server's approve/export 409s remain the only enforcement. */
export interface ApprovalReadiness {
  /** (docType, fieldKey) pairs the ENGINE requires that are not human-cleared
   *  yet — absent row, missing document, or still AI_DRAFT (the same
   *  "uncleared" definition the export gate's missingCriteria uses). */
  outstanding: Array<{ docType: DocType; fieldKey: string }>;
  /** required document types with no upload at all (their fields are in
   *  `outstanding` too) */
  missingDocs: DocType[];
  /** unresolved BLOCKING FAIL rule keys — the criteria the machine's APPROVE
   *  gate reads (the 409's missingCriteria.unresolvedBlockingChecks) */
  blocking: string[];
  /** fields with CORRECTED provenance */
  corrections: number;
  /** checks currently accepted-with-note (resolvedAt set; a re-fail clears it) */
  resolutions: number;
}

export interface ReadinessInput {
  documents: ReadonlyArray<{ type: string }>;
  fields: ReadonlyArray<{ documentType: string; fieldKey: string; status: string }>;
  checks: ReadonlyArray<{ ruleKey: string; result: string; severity: string; resolvedAt: string | null }>;
}

export function approvalReadiness(input: ReadinessInput): ApprovalReadiness {
  const missingDocs = DOC_TYPES.filter((t) => !input.documents.some((d) => d.type === t));
  const outstanding: Array<{ docType: DocType; fieldKey: string }> = [];
  for (const docType of DOC_TYPES) {
    const rows = input.fields.filter((f) => f.documentType === docType);
    for (const fieldKey of REQUIRED_FIELD_KEYS[docType]) {
      const row = rows.find((f) => f.fieldKey === fieldKey);
      if (!row || row.status === "AI_DRAFT") outstanding.push({ docType, fieldKey });
    }
  }
  return {
    outstanding,
    missingDocs,
    blocking: input.checks
      .filter((c) => c.result === "FAIL" && c.severity === "BLOCKING" && c.resolvedAt === null)
      .map((c) => c.ruleKey),
    corrections: input.fields.filter((f) => f.status === "CORRECTED").length,
    resolutions: input.checks.filter((c) => c.resolvedAt !== null).length,
  };
}

/* ----------------------------- audit rendering ---------------------------- */

/** Presentation-only hash truncation — the payload keeps the full value; 12
 *  hex chars is enough to correlate a row with the export record. */
function shortHash(s: string): string {
  return s.length > 12 ? `${s.slice(0, 12)}…` : s;
}

/** One detail line per audit event, rendered ONLY from the payload keys the
 *  services actually write (verified against every writeAudit call site).
 *  Unknown actions render their scalar entries generically; hash truncation is
 *  the only transformation, no payload key is reinterpreted. */
export function auditSummary(action: string, payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const str = (k: string): string | null => (typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : null);
  const num = (k: string): number | null => (typeof p[k] === "number" ? (p[k] as number) : null);
  switch (action) {
    case "SHIPMENT_CREATED":
      return [str("ref"), str("source") ? `via ${str("source")}` : null].filter(Boolean).join(" · ") || null;
    case "DOCUMENT_UPLOADED": {
      const size = num("sizeBytes");
      return [
        str("type") ? documentTypeLabel(str("type") as string) : null,
        size !== null ? formatBytes(size) : null,
        str("sha256Hex") ? `sha ${shortHash(str("sha256Hex") as string)}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null;
    }
    case "EXTRACTION_STARTED":
      return str("via") ? `via ${str("via")}` : null;
    case "DOCS_REACHED_TERMINAL": {
      const docs = num("documents");
      return (
        [str("via") ? `via ${str("via")}` : null, docs !== null ? `${docs} documents` : null]
          .filter(Boolean)
          .join(" · ") || null
      );
    }
    case "MANUAL_ENTRY": {
      const keys = Array.isArray(p.fieldKeys) ? p.fieldKeys.length : null;
      const lines = typeof p.lineItems === "number" ? p.lineItems : Array.isArray(p.lineItems) ? p.lineItems.length : null;
      return (
        [
          str("docStatus"),
          keys !== null ? `${keys} field${keys === 1 ? "" : "s"}` : null,
          lines !== null ? `${lines} line item${lines === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || null
      );
    }
    case "FIELD_CONFIRMED":
      return str("fieldKey") ? fieldLabel(str("fieldKey") as string) : null;
    case "FIELD_CORRECTED":
      return `${str("fieldKey") ? fieldLabel(str("fieldKey") as string) : "field"}: ${str("from") ?? "?"} → ${str("to") ?? "?"}`;
    case "CHECKS_RECOMPUTED": {
      const fails = num("blockingFails");
      const parts: string[] = [];
      if (fails !== null) parts.push(`blockingFails: ${fails}`);
      if (typeof p.fieldsCleared === "boolean") parts.push(`fieldsCleared: ${p.fieldsCleared}`);
      if (Array.isArray(p.results)) parts.push(`${p.results.length} checks`);
      return parts.join(" · ") || null;
    }
    case "DISCREPANCY_RESOLVED":
      return (
        [str("ruleKey") ? checkTitle(str("ruleKey") as string) : null, str("note") ? `“${str("note")}”` : null]
          .filter(Boolean)
          .join(" — ") || null
      );
    case "APPROVAL_GRANTED":
      return str("ref");
    case "APPROVAL_REVOKED":
      // Raw reason code, no interpretation — the machine's own vocabulary.
      return str("reason") ? `reason: ${str("reason")}` : null;
    case "EXPORT_GENERATED":
      return (
        [
          str("fileName"),
          str("csvSha256") ? `sha ${shortHash(str("csvSha256") as string)}` : null,
          num("bytes") !== null ? formatBytes(num("bytes") as number) : null,
        ]
          .filter(Boolean)
          .join(" · ") || null
      );
    case "EXPORT_DOWNLOADED":
      return str("fileName");
    default: {
      // Unknown-but-real payload: its scalar entries, generically.
      return (
        Object.entries(p)
          .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ") || null
      );
    }
  }
}
