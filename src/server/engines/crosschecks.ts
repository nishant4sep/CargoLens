/**
 * CargoLens cross-check engine (ADR-03) — the brief's declared "hard part".
 *
 * Design rules:
 *  - PURE TypeScript: typed snapshots in → per-rule results out. No DB, no AI, no I/O.
 *  - SCALE CONTRACT: all engine inputs are exact integers at milli (×1000) precision
 *    per src/lib/types.ts; BigInt for products; float math eliminated.
 *  - Tolerances come from lib/tolerances.ts (one documented place).
 *  - Every FAIL/WARNING cites the fields it accuses → the review UI links the banner
 *    straight to the contradicting field rows (brief: "catch mismatches").
 *  - AI NEVER runs in this engine. AI drafts values; this code validates them.
 */
import { DEFAULT_TOLERANCES, type Tolerances } from "@/lib/tolerances";
import { type DocType, type DocSnapshot, type FieldKey, type TypedFieldValue } from "@/lib/types";

export type RuleKey =
  | "REQUIRED_FIELDS"
  | "LINE_ARITHMETIC"
  | "INVOICE_TOTAL"
  | "QUANTITY_MATCH"
  | "PACKAGES_MATCH"
  | "GROSS_WEIGHT_CONSISTENCY"
  | "NET_NOT_EXCEEDS_GROSS"
  | "CONTAINER_CONSISTENCY"
  | "CURRENCY_CONSISTENCY";

export type CheckStatus = "PASS" | "FAIL" | "WARNING" | "SKIPPED";
export type CheckSeverity = "BLOCKING" | "WARNING";

export interface FieldRef {
  docType: DocType;
  fieldKey?: FieldKey;
  lineSeq?: number;
}

export interface CrossCheckResult {
  ruleKey: RuleKey;
  status: CheckStatus;
  severity: CheckSeverity;
  message: string;
  failedRefs: FieldRef[];
  /** structured extras for the review UI / API consumers */
  details?: Record<string, unknown>;
}

export type SnapshotSet = Partial<Record<DocType, DocSnapshot>>;

/* ------------------------------ accessors --------------------------------- */

function moneyOf(v: TypedFieldValue | undefined): { value: number; currency: string | null } | null {
  return v && v.kind === "MONEY" ? { value: v.value, currency: v.currency } : null;
}
function weightOf(v: TypedFieldValue | undefined): number | null {
  return v && v.kind === "WEIGHT_KG" ? v.value : null; // grams
}
function textOf(v: TypedFieldValue | undefined): string | null {
  return v && v.kind === "TEXT" ? v.value : null;
}
function countOf(v: TypedFieldValue | undefined): number | null {
  return v && v.kind === "COUNT" ? v.value : null;
}
function itemKey(desc: string): string {
  return desc.toLowerCase().replace(/\s+/g, " ").trim();
}

/* ------------------------------ CV-1 -------------------------------------- */

/** Required export-layout fields per readable document. */
const REQUIRED: Array<{ doc: DocType; keys: FieldKey[]; plusLines?: true }> = [
  { doc: "INVOICE", keys: ["invoiceNumber", "invoiceDate", "currency", "incoterm", "totalValue", "supplierName", "consigneeName"], plusLines: true },
  { doc: "PACKING_LIST", keys: ["packagesCount", "grossWeightKg"], plusLines: true },
  { doc: "BILL_OF_LADING", keys: ["containerNumber", "packagesCount", "grossWeightKg", "portOfLoading", "portOfDischarge"] },
];

export function checkRequiredFields(snaps: SnapshotSet): CrossCheckResult {
  const failed: FieldRef[] = [];
  const missing: string[] = [];

  for (const req of REQUIRED) {
    const snap = snaps[req.doc];
    if (!snap || !snap.readable) {
      missing.push(`${req.doc} document missing/unreadable`);
      continue;
    }
    for (const k of req.keys) {
      if (!snap.fields[k]) {
        failed.push({ docType: req.doc, fieldKey: k });
        missing.push(`${req.doc}.${k}`);
      }
    }
    if (req.plusLines && snap.lineItems.length === 0) {
      missing.push(`${req.doc}.lineItems`);
    }
  }

  return {
    ruleKey: "REQUIRED_FIELDS",
    status: missing.length === 0 ? "PASS" : "FAIL",
    severity: "BLOCKING",
    message:
      missing.length === 0
        ? "All required fields present across the three documents."
        : `Missing/unreadable required inputs: ${missing.join("; ")}`,
    failedRefs: failed,
    details: { missing },
  };
}

/* ------------------------------ CV-2 -------------------------------------- */

/** Per line: qty × unitPrice ≈ lineTotal (milli exact via BigInt). */
export function checkLineArithmetic(snaps: SnapshotSet, tol: Tolerances = DEFAULT_TOLERANCES): CrossCheckResult {
  const invoice = snaps.INVOICE;
  if (!invoice?.readable) {
    return { ruleKey: "LINE_ARITHMETIC", status: "SKIPPED", severity: "WARNING", message: "No readable invoice.", failedRefs: [] };
  }
  const bad: Array<{ seq: number; diffMilli: number }> = [];
  for (const li of invoice.lineItems) {
    if (!li.unitPrice || !li.lineTotal) {
      bad.push({ seq: li.seq, diffMilli: Number.NaN });
      continue;
    }
    const expected = mulMilli(li.unitPrice.minor, li.quantity); // milli
    const diff = Math.abs(expected - li.lineTotal.minor); // milli
    if (diff > tol.lineArithmetic.warnMilli) bad.push({ seq: li.seq, diffMilli: diff });
  }
  const lines = invoice.lineItems.length;
  return {
    ruleKey: "LINE_ARITHMETIC",
    status: bad.length === 0 ? "PASS" : "WARNING",
    severity: "WARNING",
    message:
      bad.length === 0
        ? `All ${lines} line(s): qty × unitPrice matches line total within ±${tol.lineArithmetic.warnMilli} milli.`
        : `Line arithmetic mismatch on line(s): ${bad.map(b => `#${b.seq} Δ ${b.diffMilli} milli`).join(", ")}.`,
    failedRefs: bad.map(b => ({ docType: "INVOICE" as const, lineSeq: b.seq })),
  };
}

function mulMilli(priceMilli: number, qtyMilli: number): number {
  // price (milli) × qty (milli) at product scale 10^-6 → back to milli: divide by 1000,
  // rounding half away from zero (ties are 3-dp-level; absorbed by the 20-milli budget).
  const product = BigInt(priceMilli) * BigInt(qtyMilli);
  const q = product / 1000n;
  const r = product % 1000n;
  const absR = r >= 0n ? r : -r;
  const bump = absR * 2n >= 1000n ? 1n : 0n;
  return Number(product >= 0n ? q + bump : q - bump);
}

/* ------------------------------ CV-3 -------------------------------------- */

export function checkInvoiceTotal(snaps: SnapshotSet, tol: Tolerances = DEFAULT_TOLERANCES): CrossCheckResult {
  const invoice = snaps.INVOICE;
  if (!invoice?.readable) {
    return { ruleKey: "INVOICE_TOTAL", status: "SKIPPED", severity: "BLOCKING", message: "No readable invoice.", failedRefs: [] };
  }
  const total = moneyOf(invoice.fields.totalValue);
  if (!total) {
    return { ruleKey: "INVOICE_TOTAL", status: "SKIPPED", severity: "BLOCKING", message: "Invoice total missing (REQUIRED_FIELDS covers presence).", failedRefs: [] };
  }
  const sum = invoice.lineItems.reduce((acc, li) => acc + (li.lineTotal?.minor ?? 0), 0);
  const diff = Math.abs(sum - total.value); // milli
  const status = diff <= tol.invoiceTotal.passMilli ? "PASS" : diff <= tol.invoiceTotal.warnMilli ? "WARNING" : "FAIL";
  return {
    ruleKey: "INVOICE_TOTAL",
    status,
    severity: "BLOCKING",
    message:
      status === "PASS"
        ? `Invoice total equals the line sum within ±${tol.invoiceTotal.passMilli} milli.`
        : `Invoice total vs line sum: Δ ${diff} milli exceeded the ${status === "FAIL" ? "FAIL" : "WARNING"} limit.`,
    failedRefs: status === "FAIL" ? [{ docType: "INVOICE", fieldKey: "totalValue" }] : [],
    details: { sumMilli: sum, totalMilli: total.value, diffMilli: diff },
  };
}

/* ------------------------------ CV-4 -------------------------------------- */

export function checkQuantityMatch(snaps: SnapshotSet, tol: Tolerances = DEFAULT_TOLERANCES): CrossCheckResult {
  const invoice = snaps.INVOICE;
  const pl = snaps.PACKING_LIST;
  if (!invoice?.readable || !pl?.readable) {
    return { ruleKey: "QUANTITY_MATCH", status: "SKIPPED", severity: "BLOCKING", message: "Needs invoice + packing list.", failedRefs: [] };
  }
  const invBy = new Map<string, number>();
  for (const li of invoice.lineItems) invBy.set(itemKey(li.description), (invBy.get(itemKey(li.description)) ?? 0) + li.quantity);
  const plBy = new Map<string, number>();
  for (const li of pl.lineItems) plBy.set(itemKey(li.description), (plBy.get(itemKey(li.description)) ?? 0) + li.quantity);

  const diffs: string[] = [];
  const failedRefs: FieldRef[] = [];
  const keys = new Set([...invBy.keys(), ...plBy.keys()]);
  for (const k of keys) {
    const a = invBy.get(k);
    const b = plBy.get(k);
    if (a === undefined || b === undefined) {
      diffs.push(`"${k}": ${a === undefined ? "not on invoice" : "not on packing list"}`);
      failedRefs.push({ docType: a === undefined ? "INVOICE" : "PACKING_LIST" });
      continue;
    }
    if (Math.abs(a - b) > tol.quantity.passMilli) {
      diffs.push(`"${k}": invoice ${fmtQty(a)} vs packing list ${fmtQty(b)}`);
      failedRefs.push({ docType: "INVOICE" }, { docType: "PACKING_LIST" });
    }
  }
  return {
    ruleKey: "QUANTITY_MATCH",
    status: diffs.length === 0 ? "PASS" : "FAIL",
    severity: "BLOCKING",
    message: diffs.length === 0 ? "Quantities match across invoice and packing list." : `Quantity mismatch (tol ±${tol.quantity.passMilli} milli): ${diffs.join("; ")}.`,
    failedRefs,
  };
}

function fmtQty(milli: number): string {
  return (milli / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/* ------------------------------ CV-5 -------------------------------------- */

export function checkPackagesMatch(snaps: SnapshotSet, tol: Tolerances = DEFAULT_TOLERANCES): CrossCheckResult {
  const a = countOf(snaps.PACKING_LIST?.fields.packagesCount);
  const b = countOf(snaps.BILL_OF_LADING?.fields.packagesCount);
  if (a == null || b == null) {
    return { ruleKey: "PACKAGES_MATCH", status: "SKIPPED", severity: "BLOCKING", message: "Needs package counts from packing list + BOL.", failedRefs: [] };
  }
  const ok = Math.abs(a - b) <= tol.packageCount.passUnits;
  return {
    ruleKey: "PACKAGES_MATCH",
    status: ok ? "PASS" : "FAIL",
    severity: "BLOCKING",
    message: ok ? `Package counts agree (${a}).` : `Package count mismatch: packing list ${a} vs BOL ${b}.`,
    failedRefs: ok ? [] : [
      { docType: "PACKING_LIST", fieldKey: "packagesCount" },
      { docType: "BILL_OF_LADING", fieldKey: "packagesCount" },
    ],
    details: { packingList: a, bol: b, diff: Math.abs(a - b) },
  };
}

/* ------------------------------ CV-6 -------------------------------------- */

const ALL_DOC_TYPES: DocType[] = ["INVOICE", "PACKING_LIST", "BILL_OF_LADING"];

export function checkGrossWeight(snaps: SnapshotSet, tol: Tolerances = DEFAULT_TOLERANCES): CrossCheckResult {
  const weights = ALL_DOC_TYPES
    .map((t) => ({ docType: t, grams: weightOf(snaps[t]?.fields.grossWeightKg) }))
    .filter((w): w is { docType: DocType; grams: number } => w.grams != null);

  if (weights.length < 2) {
    return { ruleKey: "GROSS_WEIGHT_CONSISTENCY", status: "SKIPPED", severity: "BLOCKING", message: "Needs gross weights from ≥2 documents.", failedRefs: [] };
  }
  const grams = weights.map((w) => w.grams);
  const diff = Math.max(...grams) - Math.min(...grams);
  const minG = Math.min(...grams);
  const tolGrams = Math.max(tol.weightKg.absoluteGrams, Math.round(tol.weightKg.relativeRatio * minG));
  const ok = diff <= tolGrams;

  const failedRefs: FieldRef[] = [];
  if (!ok) {
    for (const w of weights) {
      if (w.grams === Math.max(...grams) || w.grams === Math.min(...grams)) {
        if (!failedRefs.some((f) => f.docType === w.docType)) {
          failedRefs.push({ docType: w.docType, fieldKey: "grossWeightKg" });
        }
      }
    }
  }
  return {
    ruleKey: "GROSS_WEIGHT_CONSISTENCY",
    status: ok ? "PASS" : "FAIL",
    severity: "BLOCKING",
    message: ok
      ? `Gross weights agree across ${weights.length} document(s): Δ ${diff} g ≤ tol ${tolGrams} g.`
      : `Gross weight mismatch: Δ ${diff} g > tolerance ${tolGrams} g — documents: ${weights.map(w => `${w.docType} ${w.grams / 1000} kg`).join(", ")}.`,
    failedRefs,
    details: { weights, diffGrams: diff, toleranceGrams: tolGrams },
  };
}

/* ------------------------------ CV-6b ------------------------------------- */

export function checkNetNotExceedsGross(snaps: SnapshotSet): CrossCheckResult {
  const pl = snaps.PACKING_LIST;
  const net = weightOf(pl?.fields.netWeightKg);
  const gross = weightOf(pl?.fields.grossWeightKg);
  if (net == null || gross == null) {
    return { ruleKey: "NET_NOT_EXCEEDS_GROSS", status: "SKIPPED", severity: "WARNING", message: "Needs net + gross weight on the packing list.", failedRefs: [] };
  }
  const bad = net > gross;
  return {
    ruleKey: "NET_NOT_EXCEEDS_GROSS",
    status: bad ? "WARNING" : "PASS",
    severity: "WARNING",
    message: bad ? `Net weight (${(net / 1000).toFixed(3)} kg) exceeds gross (${(gross / 1000).toFixed(3)} kg) on the packing list.` : "Net ≤ gross on the packing list.",
    failedRefs: bad ? [{ docType: "PACKING_LIST", fieldKey: "netWeightKg" }] : [],
  };
}

/* ------------------------------ CV-7 -------------------------------------- */

const ISO6346 = /^[A-Z]{4}\d{7}$/;

export function checkContainers(snaps: SnapshotSet): CrossCheckResult {
  const bol = textOf(snaps.BILL_OF_LADING?.fields.containerNumber);
  const pl = textOf(snaps.PACKING_LIST?.fields.containerNumber);
  if (bol == null) {
    return { ruleKey: "CONTAINER_CONSISTENCY", status: "SKIPPED", severity: "BLOCKING", message: "Needs BOL container number.", failedRefs: [] };
  }
  const bolUpper = bol.toUpperCase();
  const isoOk = ISO6346.test(bolUpper);
  const mismatch = pl != null && pl.toUpperCase() !== bolUpper;

  const details = { bol, packingList: pl, iso6346Ok: isoOk, mismatch };
  if (mismatch) {
    return {
      ruleKey: "CONTAINER_CONSISTENCY",
      status: "FAIL",
      severity: "BLOCKING",
      message: `Container number mismatch: BOL "${bol}" vs packing list "${pl}".`,
      failedRefs: [
        { docType: "BILL_OF_LADING", fieldKey: "containerNumber" },
        { docType: "PACKING_LIST", fieldKey: "containerNumber" },
      ],
      details,
    };
  }
  if (!isoOk) {
    return {
      ruleKey: "CONTAINER_CONSISTENCY",
      status: "WARNING",
      severity: "WARNING",
      message: `BOL container "${bol}" is not ISO 6346 form (4 letters + 7 digits).`,
      failedRefs: [{ docType: "BILL_OF_LADING", fieldKey: "containerNumber" }],
      details,
    };
  }
  return {
    ruleKey: "CONTAINER_CONSISTENCY",
    status: "PASS",
    severity: "BLOCKING",
    message: `Container numbers agree; BOL value is ISO 6346 form.`,
    failedRefs: [],
    details,
  };
}

/* ------------------------------ CV-8 -------------------------------------- */

export function checkCurrency(snaps: SnapshotSet): CrossCheckResult {
  const invoice = snaps.INVOICE;
  const doc = textOf(invoice?.fields.currency)?.toUpperCase() ?? null;
  if (!invoice?.readable || doc == null) {
    return { ruleKey: "CURRENCY_CONSISTENCY", status: "SKIPPED", severity: "BLOCKING", message: "Needs invoice currency.", failedRefs: [] };
  }
  const bad: string[] = [];
  for (const li of invoice.lineItems) {
    const c = li.unitPrice?.currency ?? li.lineTotal?.currency ?? null;
    if (c != null && c.toUpperCase() !== doc) bad.push(`#${li.seq} ${c}`);
  }
  return {
    ruleKey: "CURRENCY_CONSISTENCY",
    status: bad.length === 0 ? "PASS" : "FAIL",
    severity: "BLOCKING",
    message: bad.length === 0 ? `All line items are in ${doc}.` : `Currency mismatch vs invoice ${doc}: ${bad.join(", ")}.`,
    failedRefs: bad.length === 0 ? [] : [{ docType: "INVOICE", fieldKey: "currency" }],
  };
}

/* ------------------------------ entrypoint -------------------------------- */

type Rule = { key: RuleKey; severity: CheckSeverity; fn: (s: SnapshotSet, t: Tolerances) => CrossCheckResult };

const RULES: Rule[] = [
  { key: "REQUIRED_FIELDS", severity: "BLOCKING", fn: (s) => checkRequiredFields(s) },
  { key: "LINE_ARITHMETIC", severity: "WARNING", fn: checkLineArithmetic },
  { key: "INVOICE_TOTAL", severity: "BLOCKING", fn: checkInvoiceTotal },
  { key: "QUANTITY_MATCH", severity: "BLOCKING", fn: checkQuantityMatch },
  { key: "PACKAGES_MATCH", severity: "BLOCKING", fn: checkPackagesMatch },
  { key: "GROSS_WEIGHT_CONSISTENCY", severity: "BLOCKING", fn: checkGrossWeight },
  { key: "NET_NOT_EXCEEDS_GROSS", severity: "WARNING", fn: (s) => checkNetNotExceedsGross(s) },
  { key: "CONTAINER_CONSISTENCY", severity: "BLOCKING", fn: (s) => checkContainers(s) },
  { key: "CURRENCY_CONSISTENCY", severity: "BLOCKING", fn: (s) => checkCurrency(s) },
];

/** Deterministic entrypoint: snapshots → per-rule results in stable rule order.
 *
 *  Effectiveness gate: only documents that are BOTH uploaded AND readable participate
 *  in comparison rules. A missing/UNREADABLE/FAILED document is out of scope for
 *  arithmetic comparisons — REQUIRED_FIELDS is the single gate that reports it as
 *  missing (its message says "missing/unreadable"). Without this gate, a corrupted
 *  document's stale/incorrect fields would silently sail through checks (the exact
 *  bug class this engine exists to prevent). */
function effectiveSnaps(snaps: SnapshotSet): SnapshotSet {
  const eff: SnapshotSet = {};
  for (const t of ALL_DOC_TYPES) {
    const s = snaps[t];
    if (s && s.uploaded && s.readable) eff[t] = s;
  }
  return eff;
}

export function runChecks(snaps: SnapshotSet, tol: Tolerances = DEFAULT_TOLERANCES): CrossCheckResult[] {
  const eff = effectiveSnaps(snaps);
  return RULES.map(({ severity, fn }) => {
    const r = fn(eff, tol);
    // SKIPPED keeps its declared severity (a missing check is still surfaced in UI, not a pass)
    return r.status === "SKIPPED" ? r : ({ ...r, severity } as CrossCheckResult);
  });
}

/** Count of unresolved BLOCKING FAILs — feeds the state machine guard. */
export function unresolvedBlockingCount(results: CrossCheckResult[]): number {
  return results.filter((r) => r.severity === "BLOCKING" && r.status === "FAIL").length;
}
