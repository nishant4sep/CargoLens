/**
 * Exact numeric engine for CargoLens (ADR-03).
 *
 * Internal representation rule: EVERY numeric engine input is an INTEGER at 3-decimal
 * precision ("milli-units"). Kilograms become grams ×1000 in precision terms; money in
 * cents → 3-dp scale; quantities → 3 dp.
 *
 * Why: IEEE floats cannot represent 0.1 accurately — the classic first bug in any
 * financial cross-check system is a float rounding false-PASS/FAIL. Integers make
 * equality, sums, products and tolerances exact, and give reproduction-stable tests.
 * BigInt is used for products to stay precise; results stay far below 2^53 for our real
 * magnitudes.
 */

export const MILLI = 1000;

/** Result of a decimal parse: integer at 3-dp scale, or null when not safely parseable. */
export type ParsedMilli = number;

const DECIMAL_RE = /^-?(?:\d+)(?:\.\d{1,3})?$/;
const GROUPED_RE = /^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,3})?$/;

/** Parse a STRICT decimal string into milli-units.
 *  Accepted: "-1234.567", "16320", "6.80", "-1,234.5" (comma = thousands only).
 *  Rejected: decimal comma ("6,80" is ambiguous — see normalize.ts for the lenient layer),
 *            mixed separators, >3 decimals, exponent notation, whitespace. */
export function toMilliStrict(input: string): ParsedMilli | null {
  const s = input.trim();
  if (s === "" || s === "-") return null;
  if (DECIMAL_RE.test(s)) {
    return decimalToMilli(s);
  }
  if (GROUPED_RE.test(s)) {
    return decimalToMilli(s.replace(/,/g, ""));
  }
  return null;
}

function decimalToMilli(dm: string): ParsedMilli | null {
  const neg = dm.startsWith("-");
  const body = neg ? dm.slice(1) : dm;
  const [int, frac = ""] = body.split(".");
  const frac3 = (frac + "000").slice(0, 3);
  const value = Number(int) * MILLI + Number(frac3);
  if (!Number.isFinite(value)) return null;
  return neg ? -value : value;
}

/** Multiply two milli integers into a milli integer (round half away from zero via BigInt).
 *  Used for qty × unitPrice → expected line total.
 *  Example: 2400.000 qty × 6.800 → product 2400000 × 6800 = 1.632e10 at scale 10^-6;
 *  /1000 rounds to 16320000 milli = 16,320.000 — exact. */
export function mulMilli(a: number, b: number): ParsedMilli {
  const product = BigInt(a) * BigInt(b); // scale 10^-6 total
  const q = product / BigInt(MILLI); // truncation toward zero
  const r = product % BigInt(MILLI); // sign of dividend
  const absR = r >= 0n ? r : -r;
  const bump = absR * 2n >= BigInt(MILLI) ? 1n : 0n;
  const rounded = product >= 0n ? q + bump : q - bump;
  return Number(rounded);
}

/** Format a milli integer back to a human decimal string (max 3 dp, no trailing zeros). */
export function milliToDisplay(m: number): string {
  const neg = m < 0;
  const abs = Math.abs(m);
  const whole = Math.floor(abs / MILLI);
  const frac = String(abs % MILLI).padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** |a − b| in milli units (exact integer). */
export function milliAbsDiff(a: number, b: number): number {
  return Math.abs(a - b);
}

/** Weight tolerance in GRAM-milli: max(absolute kg, ratio × min weight kg). */
export function weightToleranceMilliKg(
  weights: number[],
  tol: { absoluteKg: number; relativeRatio: number },
): number | null {
  if (weights.length < 2) return null;
  const minAbs = Math.min(...weights.map((w) => Math.abs(w)));
  const absolute = toMilliStrict(String(tol.absoluteKg))!;
  const relative = mulMilli(minAbs, toMilliStrict(String(tol.relativeRatio))!);
  return Math.max(absolute, relative);
}
