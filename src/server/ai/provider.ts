/**
 * AI extraction provider seam (Phase 5, ADR-04 / file 05 §2).
 *
 * This module is the ENTIRE contract between the extraction service and any
 * AI provider — the storage.ts pattern: swap implementations here, nowhere
 * else. It owns the model-response SCHEMA (Zod) and provider selection;
 * implementations own only the transport.
 *
 * Trust rules (file 05):
 *  - the model TRANSCRIBES; it never calculates (no sum fields in the schema —
 *    cross-check engine owns arithmetic);
 *  - every field carries evidence (page + verbatim excerpt) and a SELF-REPORTED
 *    confidence that the UI treats as eye-guidance, never as a gate;
 *  - absent values are null; illegible values are `unreadable: true` — the
 *    schema has no way to "suggest" a value the document does not contain;
 *  - the response is UNVALIDATED here: `extract()` returns the provider's
 *    parsed JSON as `unknown`, and the SERVICE validates with RawExtractionSchema
 *    so a schema drift can be repaired (one retry) by feeding the Zod issues back.
 */
import { z } from "zod";
import { FIELD_KEYS, type DocType } from "@/lib/types";
import { trimText } from "@/server/engines/normalize";
import { geminiProvider } from "./gemini";
import { getStubProvider } from "./stub";

/* --------------------------- model response schema ------------------------ */
/* Lenient IN (models are sloppy: excerpts may be long), strict ABOUT (unknown
 * field keys, out-of-range confidence and non-integer pages are rejected, not
 * silently coerced — a rejected response goes to the repair path instead). */

const excerptSchema = z
  .string()
  .max(400)
  .nullish()
  .transform((v) => (v == null ? null : trimText(v, 120)));

export const RawFieldSchema = z
  .object({
    fieldKey: z.enum(FIELD_KEYS),
    /** The value EXACTLY as printed (canonical formatting), or null when absent. */
    value: z.string().max(200).nullable(),
    unreadable: z.boolean(),
    /** Model self-reported confidence ∈ [0,1] — NOT calibrated, never a gate. */
    confidence: z.number().min(0).max(1),
    page: z.number().int().min(1).max(10_000),
    excerpt: excerptSchema,
  })
  .strict();

export const RawLineItemSchema = z
  .object({
    seq: z.number().int().min(1).max(9999),
    description: z.string().min(1).max(200),
    hsnCode: z.string().max(20).nullable(),
    qty: z.string().max(60).nullable(),
    unit: z.string().max(20).nullable(),
    unitPrice: z.string().max(60).nullable(),
    lineTotal: z.string().max(60).nullable(),
    confidence: z.number().min(0).max(1),
    page: z.number().int().min(1).max(10_000),
    excerpt: excerptSchema,
  })
  .strict();

export const RawExtractionSchema = z
  .object({
    fields: z.array(RawFieldSchema).max(40),
    lineItems: z.array(RawLineItemSchema).max(200),
    /** The whole document is illegible/not a recognizable import document. */
    documentUnreadable: z.boolean(),
    unreadableReason: z.string().max(300).nullable(),
  })
  .strict();

export type RawField = z.infer<typeof RawFieldSchema>;
export type RawLineItem = z.infer<typeof RawLineItemSchema>;
/** Post-transform shape: `excerpt` is `string | null` (≤120 chars). */
export type RawExtraction = z.infer<typeof RawExtractionSchema>;

/* ------------------------------ provider seam ----------------------------- */

export interface ExtractInput {
  /** Raw document bytes (private-storage read — never a user-visible path). */
  bytes: Buffer;
  /** Sniffed MIME: application/pdf | image/png | image/jpeg (row 8's sniff). */
  mimeType: string;
  /** Which document this is — tells the model what kind of page to expect. */
  docType: DocType;
  /** Second-attempt hint: the previous try's schema issues (repair path). */
  repairNote?: string;
}

export interface ExtractionProvider {
  /** Audit-visible tag. The stub MUST self-identify as non-AI (brief rule). */
  readonly name: string;
  /** Resolves to the provider's parsed JSON, or throws ProviderError. */
  extract(input: ExtractInput): Promise<unknown>;
}

/** Transport/response failure (HTTP status, timeout, unparseable body). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** No provider is configured (missing key) — the service maps this to 503. */
export class ProviderUnavailableError extends Error {
  constructor(message = "No AI provider is configured (GEMINI_API_KEY is not set)") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * Provider selection. `EXTRACTION_PROVIDER=stub` selects the deterministic
 * test double — which REFUSES to run outside a test runtime (vitest sets
 * VITEST=true), so the variable can never flip a real deployment to fake
 * extraction. Default (and every production path): the Gemini REST provider,
 * unavailable-with-503 when no key is configured.
 */
export function getProvider(): ExtractionProvider {
  if (process.env.EXTRACTION_PROVIDER === "stub") return getStubProvider();
  if (!process.env.GEMINI_API_KEY) throw new ProviderUnavailableError();
  return geminiProvider;
}
