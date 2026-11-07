/**
 * Deterministic stub provider (Phase 5, P5.0) — a PERFECT TEXT READER, not an AI.
 *
 * It "extracts" by parsing the synthetic PDFs' text layer with fixed regexes —
 * the same bytes a vision model would look at, read mechanically. This makes
 * the whole downstream pipeline (schema → parseCorrection → persistence →
 * checks → review UI) testable and demoable WITHOUT network, secrets, or
 * nondeterminism, while never being representable as real extraction:
 *   - it refuses to construct outside a test runtime (VITEST / NODE_ENV=test);
 *   - `name` self-identifies and lands in EXTRACTION_* audit payloads verbatim;
 *   - `getProvider()` (provider.ts) never selects it by default.
 *
 * Honesty rules mirrored from the real contract: absent → null, illegible →
 * unreadable:true, no labels at all → documentUnreadable. It computes nothing
 * the page does not print (no arithmetic, no inference).
 */
import { FIELD_KINDS, isFieldKey, type FieldKey } from "@/lib/types";
import { FIELD_CONFIDENCE } from "@/server/seed/fixtures";
import { DOC_LABELS, isNumericKind } from "./synthetic-pdf";
import type { ExtractInput, ExtractionProvider } from "./provider";

/** Only a test runtime may ever build the stub — fail loud, never fake prod. */
function assertTestRuntime(): void {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error(
      "stub provider is TEST-ONLY (EXTRACTION_PROVIDER=stub outside a test runtime is a misconfiguration)",
    );
  }
}

/** Pulls the literal text ops out of the generator's minimal PDFs. */
function pdfTextLines(bytes: Buffer): string[] {
  const raw = bytes.toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
    out.push(m[1].replace(/\\([()\\])/g, "$1").trim());
  }
  return out;
}

const STUB_NAME = "stub-text-reader (deterministic, NOT AI)";

export function getStubProvider(): ExtractionProvider {
  assertTestRuntime();
  return {
    name: STUB_NAME,
    async extract(input: ExtractInput): Promise<unknown> {
      const lines = pdfTextLines(input.bytes);

      const byLabel = new Map<string, string>(
        lines.filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l]),
      );

      const fields: unknown[] = [];
      for (const [key, label] of Object.entries(DOC_LABELS) as [FieldKey, string][]) {
        const line = byLabel.get(label.toLowerCase());
        if (!line) continue; // document does not show this field → absent → no row
        const printed = line.slice(line.indexOf(":") + 1).trim();
        const unreadable = printed === "" || /illegible/i.test(printed);
        let value: string | null = null;
        if (!unreadable) {
          if (isNumericKind(key)) {
            const num = printed.match(/-?[\d.,]+/); // first numeric token ("USD 16,320.00" → "16,320.00"; "3,120.00 kg" → "3,120.00")
            if (!num) {
              fields.push({ fieldKey: key, value: null, unreadable: true, confidence: FIELD_CONFIDENCE[key] ?? 0.95, page: 1, excerpt: line.slice(0, 120) });
              continue;
            }
            value = num[0];
          } else {
            value = printed; // canonical text: dates are printed ISO, currency codes bare
          }
        }
        fields.push({
          fieldKey: key,
          value,
          unreadable,
          confidence: unreadable ? 0.1 : (FIELD_CONFIDENCE[key] ?? 0.95),
          page: 1,
          excerpt: line.slice(0, 120),
        });
      }

      const lineItems: unknown[] = [];
      for (const line of lines) {
        const m = line.match(/^Item (\d+):\s*(.+?)\s*\|\s*HSN:\s*([\w-]+|\-)\s*\|\s*([\d.,]+)(?:\s*([A-Za-z]+))?\s*x\s*([\d.,]+)\s*=\s*([\d.,]+)\s*$/);
        if (!m) continue;
        lineItems.push({
          seq: Number(m[1]),
          description: m[2],
          hsnCode: m[3] === "-" ? null : m[3],
          qty: m[4],
          unit: m[5] ?? null,
          unitPrice: m[6],
          lineTotal: m[7],
          confidence: 0.95,
          page: 1,
          excerpt: line.slice(0, 120),
        });
      }

      const readable = fields.length > 0 || lineItems.length > 0;
      return {
        fields,
        lineItems,
        documentUnreadable: !readable,
        unreadableReason: readable ? null : "No recognizable import-document labels found on the page",
      };
    },
  };
}

/** Kept next to the reader so reviewers see both halves of the contract: the
 *  field dictionary's kinds drive what "a value" means (never raw string dumps). */
export function isKnownFieldKey(key: string): key is FieldKey {
  return isFieldKey(key) && FIELD_KINDS[key] !== undefined;
}
