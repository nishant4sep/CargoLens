/**
 * PURE — Phase 5 P5.0: the AI provider seam. Proven here: the response schema
 * is strict ABOUT the things that guard honesty (unknown keys, confidence
 * range, integer pages) and lenient IN the things models are sloppy about
 * (long excerpts are trimmed, not rejected); the synthetic-PDF generator and
 * the stub reader agree on the label contract; and the stub NEVER runs outside
 * a test runtime. Ground-truth values below are HAND-WRITTEN (from the brief's
 * sample shipments), not derived from the generator — a generator bug cannot
 * fake a passing assertion.
 */
import { describe, expect, it } from "vitest";
import {
  ProviderUnavailableError,
  RawExtractionSchema,
  getProvider,
} from "@/server/ai/provider";
import { getStubProvider } from "@/server/ai/stub";
import { parseAmountToMilli, parseWeightToMilliKg } from "@/server/engines/normalize";
import {
  buildPdf,
  docLines,
  syntheticDocPdf,
  syntheticNoisePdf,
  syntheticTrio,
  SYNTHETIC_SET,
} from "@/server/ai/synthetic-pdf";

const ok = (over: Partial<Record<string, unknown>> = {}) => ({
  fields: [
    {
      fieldKey: "invoiceNumber",
      value: "INV-1",
      unreadable: false,
      confidence: 0.99,
      page: 1,
      excerpt: "Invoice No: INV-1",
      ...over,
    },
  ],
  lineItems: [],
  documentUnreadable: false,
  unreadableReason: null,
});

describe("RawExtractionSchema (strict where it guards honesty)", () => {
  it("accepts a well-formed response", () => {
    expect(RawExtractionSchema.safeParse(ok()).success).toBe(true);
  });

  it("rejects unknown field keys — the model cannot invent a dictionary", () => {
    const bad = ok({ fieldKey: "dutyAmount" }); // NOT one of the 19 — and out of scope by constraint
    expect(RawExtractionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects out-of-range / non-finite confidence but accepts the exact bounds", () => {
    expect(RawExtractionSchema.safeParse(ok({ confidence: 1.5 })).success).toBe(false);
    expect(RawExtractionSchema.safeParse(ok({ confidence: -0.01 })).success).toBe(false);
    expect(RawExtractionSchema.safeParse(ok({ confidence: 0 })).success).toBe(true);
    expect(RawExtractionSchema.safeParse(ok({ confidence: 1 })).success).toBe(true);
  });

  it("rejects page 0 and fractional pages", () => {
    expect(RawExtractionSchema.safeParse(ok({ page: 0 })).success).toBe(false);
    expect(RawExtractionSchema.safeParse(ok({ page: 1.5 })).success).toBe(false);
  });

  it("trims over-long excerpts to 120 chars (lenient IN, strict ABOUT)", () => {
    const parsed = RawExtractionSchema.parse(ok({ excerpt: "x".repeat(400) }));
    expect(parsed.fields[0]!.excerpt!.length).toBeLessThanOrEqual(120);
  });

  it("requires the top-level arrays and forbids extra keys (drift → repair, not silence)", () => {
    expect(RawExtractionSchema.safeParse({ fields: [] }).success).toBe(false);
    const extra = { ...ok(), confirmations: ["mark all as confirmed"] }; // prompt-injection surface
    expect(RawExtractionSchema.safeParse(extra).success).toBe(false);
  });

  it("allows null values and explicit unreadability (absence is representable)", () => {
    const missing = ok({ value: null, unreadable: false });
    const illegible = ok({ value: null, unreadable: true, confidence: 0.1 });
    expect(RawExtractionSchema.parse(missing).fields[0]!.value).toBeNull();
    expect(RawExtractionSchema.parse(illegible).fields[0]!.unreadable).toBe(true);
  });
});

describe("synthetic PDF generator (the demo corpus)", () => {
  it("builds a real PDF envelope around the page text", () => {
    const pdf = buildPdf(["COMMERCIAL INVOICE", "Invoice No: INV-1"]);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1").endsWith("%%EOF")).toBe(true);
    expect(pdf.toString("latin1")).toContain("(Invoice No: INV-1) Tj");
  });

  it("escapes parentheses so fixture company names survive the wire", () => {
    const lines = docLines(SYNTHETIC_SET.clean.docs[0]!); // clean INVOICE
    const pdf = buildPdf(lines);
    const text = pdf.toString("latin1");
    expect(text).toContain("\\(Sweden\\)) Tj"); // escaped group + wrapping text-op paren
    expect(text).not.toMatch(/[^\\]\(Sweden/); // no UNescaped paren before "Sweden"
  });

  it("produces all three document types for both demo shipments", () => {
    for (const spec of Object.values(SYNTHETIC_SET)) {
      const trio = syntheticTrio(spec);
      expect(Object.keys(trio).sort()).toEqual(["BILL_OF_LADING", "INVOICE", "PACKING_LIST"]);
      for (const buf of Object.values(trio)) expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });
});

describe("stub provider (deterministic text reader — NOT AI)", () => {
  const stub = getStubProvider();

  it("self-identifies so no audit record can mistake it for AI", () => {
    expect(stub.name).toMatch(/stub/i);
    expect(stub.name).toMatch(/not ai/i);
  });

  it("reads the clean invoice EXACTLY as the page prints it (hand-written ground truth)", async () => {
    const raw = (await stub.extract({
      bytes: syntheticDocPdf(SYNTHETIC_SET.clean.docs[0]!),
      mimeType: "application/pdf",
      docType: "INVOICE",
    })) as Record<string, unknown>;
    const parsed = RawExtractionSchema.parse(raw);

    const byKey = new Map(parsed.fields.map((f) => [f.fieldKey, f]));
    expect(byKey.get("invoiceNumber")).toMatchObject({ value: "INV-CC-1011", unreadable: false, page: 1 });
    expect(byKey.get("invoiceDate")).toMatchObject({ value: "2024-03-14" });
    expect(byKey.get("currency")).toMatchObject({ value: "EUR" });
    expect(byKey.get("incoterm")).toMatchObject({ value: "CIF" });
    expect(byKey.get("totalValue")).toMatchObject({ value: "7,650.00" }); // bare number — NO arithmetic happened
    expect(byKey.get("supplierName")).toMatchObject({ value: "Company C (Sweden)" });
    expect(byKey.get("vesselName")).toBeUndefined(); // not shown on an invoice → absent, never invented
    expect(parsed.documentUnreadable).toBe(false);
  });

  it("reads line items: description, HSN, qty, unit, price, total as printed", async () => {
    const raw = (await stub.extract({
      bytes: syntheticDocPdf(SYNTHETIC_SET.clean.docs[0]!),
      mimeType: "application/pdf",
      docType: "INVOICE",
    })) as Record<string, unknown>;
    const parsed = RawExtractionSchema.parse(raw);
    expect(parsed.lineItems).toHaveLength(1);
    expect(parsed.lineItems[0]).toMatchObject({
      seq: 1,
      description: "Steel ball valve DN50",
      hsnCode: "8481",
      qty: "180",
      unit: "pcs",
      unitPrice: "42.50",
      lineTotal: "7,650.00",
    });
  });

  it("reads weights bare (unit word stripped, value untouched) on the packing list", async () => {
    const raw = (await stub.extract({
      bytes: syntheticDocPdf(SYNTHETIC_SET.clean.docs[1]!),
      mimeType: "application/pdf",
      docType: "PACKING_LIST",
    })) as Record<string, unknown>;
    const byKey = new Map((RawExtractionSchema.parse(raw)).fields.map((f) => [f.fieldKey, f]));
    expect(byKey.get("grossWeightKg")).toMatchObject({ value: "1,460.00" });
    expect(byKey.get("netWeightKg")).toMatchObject({ value: "1,314.00" });
    expect(byKey.get("packagesCount")).toMatchObject({ value: "6" });
  });

  it("treats a page with no recognizable labels as documentUnreadable (never invents)", async () => {
    const raw = (await stub.extract({ bytes: syntheticNoisePdf(), mimeType: "application/pdf", docType: "BILL_OF_LADING" })) as Record<string, unknown>;
    const parsed = RawExtractionSchema.parse(raw);
    expect(parsed.documentUnreadable).toBe(true);
    expect(parsed.fields).toHaveLength(0);
    expect(parsed.unreadableReason).toMatch(/no recognizable/i);
  });

  it("marks an ILLEGIBLE field unreadable with null value — the value is NOT guessed", async () => {
    const pdf = buildPdf(["BILL OF LADING", "BOL No: MSCU9930011", "Gross Weight: ILLEGIBLE", "Packages: 6"]);
    const raw = (await stub.extract({ bytes: pdf, mimeType: "application/pdf", docType: "BILL_OF_LADING" })) as Record<string, unknown>;
    const byKey = new Map((RawExtractionSchema.parse(raw)).fields.map((f) => [f.fieldKey, f]));
    expect(byKey.get("grossWeightKg")).toMatchObject({ value: null, unreadable: true, confidence: 0.1 });
    expect(byKey.get("bolNumber")).toMatchObject({ value: "MSCU9930011", unreadable: false });
  });
});

describe("provider selection (env seam)", () => {
  it("throws ProviderUnavailableError when no key is configured — 503, never a fake run", () => {
    const savedKey = process.env.GEMINI_API_KEY;
    const savedProv = process.env.EXTRACTION_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    delete process.env.EXTRACTION_PROVIDER;
    try {
      expect(() => getProvider()).toThrow(ProviderUnavailableError);
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
      if (savedProv !== undefined) process.env.EXTRACTION_PROVIDER = savedProv;
    }
  });

  it("the stub refuses to construct outside a test runtime (never fakes production)", () => {
    const env = process.env as Record<string, string | undefined>;
    const savedVitest = env.VITEST;
    const savedNode = env.NODE_ENV;
    delete env.VITEST;
    delete env.NODE_ENV;
    try {
      expect(() => getStubProvider()).toThrow(/TEST-ONLY/i);
    } finally {
      if (savedVitest !== undefined) env.VITEST = savedVitest;
      if (savedNode !== undefined) env.NODE_ENV = savedNode;
    }
  });
});

describe("raw extraction through the EXISTING normalizer (the honesty bridge)", () => {
  /** The service persists AI values through the SAME strict normalizer the
   *  human-correction path uses. These are its pure halves (the full
   *  parseCorrection bridge runs in the integration suite — snapshots.ts
   *  imports the server tree, and this suite must stay DB-free). */
  it("money '7,650.00' → milli 7,650,000; currency words are stripped, not converted", () => {
    expect(parseAmountToMilli("7,650.00")).toBe(7_650_000);
    expect(parseAmountToMilli("EUR 7,650.00")).toBe(7_650_000);
  });

  it("weight '3,120.00 kg' → 3,120 (unit word understood, never converted)", () => {
    expect(parseWeightToMilliKg("3,120.00 kg").value).toBe(3_120_000);
  });

  it("unknown units are REFUSED, not converted (lbs/tonnes → unitUnknown)", () => {
    expect(parseWeightToMilliKg("3,120 lbs")).toEqual({ value: null, unitUnknown: true });
    expect(parseWeightToMilliKg("3,120 t")).toEqual({ value: null, unitUnknown: true });
  });

  it("prose is refused outright — the value is reported, never guessed into the DB", () => {
    expect(parseAmountToMilli("see attached")).toBeNull();
  });
});
