/**
 * Lenient normalization layer for real-world document text (ADR-03, file 05 §2 step 5).
 *
 * This is the deliberate boundary between "what the OCR/model saw" (raw strings from
 * documents) and "what deterministic engines reason about" (typed values from types.ts).
 * Rules are documented + unit tested; anything ambiguous returns null and drops to
 * the human/manual path instead of silently guessing.
 */
import { toMilliStrict, type ParsedMilli } from "./numeric";
import { MILLI } from "./numeric";

/* --------------------------------- money --------------------------------- */

const CURRENCY_TOKENS =
  /(?:USD|US\$|USD\$|EURO?[^A-Za-z]|EUR[^A-Za-z]|INR[^A-Za-z]|rs\.?|₹|rs\b|\$|€|£|¥)/gi;

/**
 * Parse an amount that may carry currency symbol/code, thousand separators, and either
 * decimal convention (dot or comma).
 *
 * Disambiguation rules (documented, tested):
 *  1. Strip currency tokens and spaces.
 *  2. If both "." and "," appear: the LAST separator is the decimal; earlier ones are
 *     grouping → remove grouping separators.
 *  3. If only "," appears:
 *     - exactly 1–2 digits after the (single) comma → decimal comma ("6,80" → 6.80)
 *     - otherwise treat all commas as thousands separators ("1,234" → 1234;
 *       INDIAN grouping "12,34,567" → 1234567 works because we simply delete commas)
 *  4. If only "." appears with >3 decimals → reject (not a money value at ≤3 dp).
 *  What remains must satisfy the strict grammar.
 */
export function parseAmountToMilli(raw: string): ParsedMilli | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === "") return null;
  s = s.replace(CURRENCY_TOKENS, " ").replace(/\s+/g, "");
  if (s === "") return null;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot > lastComma) {
      s = s.replace(/,/g, ""); // "6,845.30" → 6845.30 ; INR "1,23,456.78" → 123456.78
    } else {
      s = s.replace(/\./g, "").replace(",", "."); // "3.123,4" → 3123.4
    }
  } else if (hasComma) {
    const parts = s.split(",");
    const trailing = parts[parts.length - 1] ?? "";
    if (parts.length === 2 && trailing.length >= 1 && trailing.length <= 2) {
      s = parts[0] + "." + trailing; // decimal comma: "6,80" → 6.80
    } else {
      s = s.replace(/,/g, ""); // thousands: "1,234" / "12,34,567"
    }
  }

  // >3 decimals cannot be represented at milli scale — not a rounding case we accept.
  const abs = s.replace("-", "");
  const decIndex = abs.indexOf(".");
  if (decIndex !== -1 && abs.slice(decIndex + 1).length > 3) return null;

  return toMilliStrict(s);
}

/* --------------------------------- weight -------------------------------- */

// unit may appear before the number ("KGS 3,165") and/or after ("3,120 kg"), or be absent
const KG_TOKENS =
  /^(?:\s*)(?:kg|kgs\.?|kilo(?:gram)?s?)?\s*([-0-9.,]+)\s*(?:kg|kgs\.?|kilo(?:gram)?s?)?\s*$/i;

/**
 * Parse a gross/net weight into milli-kg. Unit-capable tokens: kg (incl. "KGS.", "kilograms").
 * Any OTHER unit (t, MT, lb) → null with a flagged reason — never silently converted.
 */
export function parseWeightToMilliKg(raw: string): { value: ParsedMilli | null; unitUnknown: boolean } {
  const t = String(raw ?? "").trim();
  if (t === "") return { value: null, unitUnknown: false };
  if (/\b(mt|tonnes?|tons?|t\b|lbs?|pounds?)\b/i.test(t)) return { value: null, unitUnknown: true };
  const m = t.match(KG_TOKENS);
  if (!m) return { value: null, unitUnknown: false };
  const num = parseAmountToMilli(m[1]);
  return { value: num, unitUnknown: false };
}

/* --------------------------------- dates --------------------------------- */

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Parse common invoice/BOL date formats to ISO "yyyy-mm-dd".
 * Supported (tested): yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy,
 * dd MMM yyyy, dd-MMM-yyyy (e.g. MAR 12, 2024), "12 MAR 24".
 * 2-digit years: 00–69 → 2000s, 70–99 → 1900s (documented pivot, tests cover).
 */
export function parseDateToIso(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/(st|nd|rd|th)/gi, "");

  let m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = cleaned.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (m) return iso(+m[3], +m[2], +m[1]); // dd/mm/yyyy family

  m = cleaned.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2})$/);
  if (m) {
    const y = +m[3];
    const full = y < 70 ? 2000 + y : 1900 + y;
    return iso(full, +m[2], +m[1]);
  }

  m = cleaned.match(/^(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,9})\s*[-\s]\s*(\d{4})$/);
  if (m) return withMonthName(m[2], +m[1], +m[3]);

  m = cleaned.match(/^([A-Za-z]{3,9})\s*[-\s]\s*(\d{1,2}),?\s*(\d{4})$/);
  if (m) return withMonthName(m[1], +m[2], +m[3]);

  m = cleaned.match(/^(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,9})\s*[-\s]\s*(\d{2})$/);
  if (m) {
    const y = +m[3];
    const full = y < 70 ? 2000 + y : 1900 + y;
    return withMonthName(m[2], +m[1], full);
  }

  return null;
}

function withMonthName(name: string, day: number, year: number): string | null {
  const mm = MONTHS[name.slice(0, 3).toLowerCase()];
  if (!mm) return null;
  return iso(year, +mm, day);
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  // real calendar validation (reject 31 Feb etc.)
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* -------------------------------- Incoterm ------------------------------- */

const INCOTERMS = new Set([
  "EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF",
]);

export function normalizeIncoterm(raw: string): string | null {
  const s = String(raw ?? "").trim().toUpperCase();
  const m = s.match(/\b(EXW|FCA|CPT|CIP|DAP|DPU|DDP|FAS|FOB|CFR|CIF)\b(?:\s*([\s\S]{0,40}))?/);
  if (!m) return null;
  const term = m[1];
  // Optional trailing port qualifier is kept as info but the term alone is canonical.
  void m[2];
  return INCOTERMS.has(term) ? term : null;
}

/* ------------------------------ misc helpers ----------------------------- */

export function trimText(raw: string, max: number): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export const _MILLI = MILLI; // re-export for tests that assert the constant
