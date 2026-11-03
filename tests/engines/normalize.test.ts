import { describe, expect, it } from "vitest";
import {
  normalizeIncoterm,
  parseAmountToMilli,
  parseDateToIso,
  parseWeightToMilliKg,
  trimText,
} from "@/server/engines/normalize";

describe("parseAmountToMilli (loose document-text layer)", () => {
  it("strips currency symbols/codes", () => {
    expect(parseAmountToMilli("USD 6.80")).toBe(6800);
    expect(parseAmountToMilli("€ 42.50")).toBe(42500);
    expect(parseAmountToMilli("₹1,23,456.78")).toBe(123456780);
    expect(parseAmountToMilli("US$6.80")).toBe(6800);
    expect(parseAmountToMilli("Rs.1,200.50")).toBe(1200500);
  });

  it("decimal comma when 1–2 digits trail a single comma", () => {
    expect(parseAmountToMilli("6,80")).toBe(6800);
    expect(parseAmountToMilli("7650,00")).toBe(7650000);
  });

  it("thousands commas (incl. Indian 2-digit groups) keep their digits", () => {
    expect(parseAmountToMilli("1,234")).toBe(1234000);
    expect(parseAmountToMilli("12,34,567")).toBe(1234567000);
    expect(parseAmountToMilli("3,120")).toBe(3120000);
  });

  it("last separator wins when dot and comma coexist", () => {
    expect(parseAmountToMilli("6,845.30")).toBe(6845300);
    expect(parseAmountToMilli("1,23,456.78")).toBe(123456780);
    expect(parseAmountToMilli("3.123,4")).toBe(3123400);
  });

  it("rejects hopeless input rather than guessing", () => {
    expect(parseAmountToMilli("")).toBeNull();
    expect(parseAmountToMilli("1.2345")).toBeNull(); // >3 decimals
    expect(parseAmountToMilli(" greetings ")).toBeNull();
  });
});

describe("parseWeightToMilliKg", () => {
  it("supports kg-unit variants and plain numbers", () => {
    expect(parseWeightToMilliKg("3120")).toEqual({ value: 3120000, unitUnknown: false });
    expect(parseWeightToMilliKg("3,120 kg")).toEqual({ value: 3120000, unitUnknown: false });
    expect(parseWeightToMilliKg("KGS. 3165")).toEqual({ value: 3165000, unitUnknown: false });
    expect(parseWeightToMilliKg("4.5 kilograms")).toEqual({ value: 4500, unitUnknown: false });
  });

  it("flags non-kg units instead of silently converting", () => {
    expect(parseWeightToMilliKg("3.16 MT")).toEqual({ value: null, unitUnknown: true });
    expect(parseWeightToMilliKg("5 tonnes")).toEqual({ value: null, unitUnknown: true });
    expect(parseWeightToMilliKg("45 lb")).toEqual({ value: null, unitUnknown: true });
  });
});

describe("parseDateToIso", () => {
  it("parses the formats brokers actually send", () => {
    expect(parseDateToIso("2024-03-12")).toBe("2024-03-12");
    expect(parseDateToIso("12/03/2024")).toBe("2024-03-12");
    expect(parseDateToIso("12-03-2024")).toBe("2024-03-12");
    expect(parseDateToIso("12.03.2024")).toBe("2024-03-12");
    expect(parseDateToIso("12 MAR 2024")).toBe("2024-03-12");
    expect(parseDateToIso("MAR 12, 2024")).toBe("2024-03-12");
    expect(parseDateToIso("12-MAR-24")).toBe("2024-03-12");
  });

  it("rejects impossible dates", () => {
    expect(parseDateToIso("31/02/2024")).toBeNull(); // no Feb 31
    expect(parseDateToIso("13/13/2024")).toBeNull(); // month 13
    expect(parseDateToIso("ÅÑØ")).toBeNull();
  });

  it("2-digit year pivot 70 is documented behavior", () => {
    expect(parseDateToIso("12-03-69")).toBe("2069-03-12");
    expect(parseDateToIso("12-03-70")).toBe("1970-03-12");
  });
});

describe("normalizeIncoterm", () => {
  it("returns the canonical ICC term", () => {
    expect(normalizeIncoterm("FOB Nhava Sheva")).toBe("FOB");
    expect(normalizeIncoterm("cif")).toBe("CIF");
    expect(normalizeIncoterm("EXW (Incoterms 2020)")).toBe("EXW");
  });
  it("rejects unknown vocabulary", () => {
    expect(normalizeIncoterm("DELIVERED DUTY PAID")).toBeNull();
    expect(normalizeIncoterm("")).toBeNull();
  });
});

describe("trimText", () => {
  it("collapses whitespace and hard-caps length", () => {
    expect(trimText("  LED   panel\nlight 40W  ", 100)).toBe("LED panel light 40W");
    expect(trimText("a".repeat(200), 120)).toHaveLength(120);
    expect(trimText("a".repeat(200), 120)).toMatch(/…$/);
  });
});
