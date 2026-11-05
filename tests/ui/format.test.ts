/**
 * PURE — document display helpers (src/lib/format.ts): byte formatting and
 * per-document status labels. No DB, no React.
 */
import { describe, expect, it } from "vitest";
import { documentStatusLabel, documentTypeLabel, formatBytes } from "@/lib/format";

describe("formatBytes", () => {
  it("formats the B → KB → MB ladder a document table shows", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
  });

  it("caps at GB and degrades invalid input", () => {
    expect(formatBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
    expect(formatBytes(5 * 1024 ** 4)).toMatch(/ TB$| GB$/); // beyond GB: capped unit, still a string
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("documentStatusLabel", () => {
  it("maps every DocumentStatus to a human label", () => {
    expect(documentStatusLabel("UPLOADED")).toBe("Uploaded");
    expect(documentStatusLabel("PROCESSING")).toBe("Extracting");
    expect(documentStatusLabel("PROCESSED")).toBe("Processed");
    expect(documentStatusLabel("UNREADABLE")).toBe("Unreadable");
    expect(documentStatusLabel("FAILED")).toBe("Failed");
  });

  it("unknown statuses render raw (honest UI)", () => {
    expect(documentStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("documentTypeLabel", () => {
  it("maps the three contract doc types; unknown renders raw", () => {
    expect(documentTypeLabel("INVOICE")).toBe("Invoice");
    expect(documentTypeLabel("PACKING_LIST")).toBe("Packing list");
    expect(documentTypeLabel("BILL_OF_LADING")).toBe("Bill of lading");
    expect(documentTypeLabel("PASSPORT")).toBe("PASSPORT");
  });
});
