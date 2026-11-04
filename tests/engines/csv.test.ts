/**
 * Pure unit tests for the CSV writer (contract row 16) — NO database; bytes
 * must be deterministic because ExportRecord stores sha256(csvContent) and
 * re-downloads are byte-compared.
 */
import { describe, expect, it } from "vitest";
import { CSV_FORMAT_VERSION, csvCell, EXPORT_HEADER, toCsv } from "@/server/engines/csv";

describe("csvCell", () => {
  it("plain values pass through unchanged", () => {
    expect(csvCell("SHP-24811")).toBe("SHP-24811");
    expect(csvCell(16320)).toBe("16320");
    expect(csvCell(6.8)).toBe("6.8");
  });

  it("null and undefined become empty cells", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("commas, quotes and newlines are RFC-4180 quoted/escaped", () => {
    expect(csvCell("valve, DN50")).toBe('"valve, DN50"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("string cells starting with formula characters get a guard apostrophe", () => {
    for (const evil of ["=SUM(A1)", "+cmd", "-macro", "@x", "\ttab", "\rcr"]) {
      const cell = csvCell(evil);
      // Two-layer defense: the guard apostrophe leads the cell VALUE; if the
      // value also contains RFC-special chars (CR here) the whole cell is
      // quoted on top: "'<CR>cr" — apostrophe first either way.
      expect([`'${evil}`, `"'${evil}"`]).toContain(cell);
    }
  });

  it("number cells are NEVER mangled (negative numbers stay numeric)", () => {
    expect(csvCell(-45)).toBe("-45");
  });
});

describe("toCsv", () => {
  it("uses CRLF line endings and terminates the last row", () => {
    const csv = toCsv(["a", "b"], [{ a: "1", b: "2" }]);
    expect(csv).toBe("a,b\r\n1,2\r\n");
  });

  it("rows follow header order and missing keys become empty cells", () => {
    const csv = toCsv(["a", "b", "c"], [{ b: "2", a: "1" }]);
    expect(csv).toBe("a,b,c\r\n1,2,\r\n");
  });

  it("the export layout is pinned (format v1, contract row 16)", () => {
    expect(CSV_FORMAT_VERSION).toBe("cargolens-csv-v1");
    expect(EXPORT_HEADER[0]).toBe("shipmentRef");
    expect(EXPORT_HEADER).toContain("lineTotal");
  });
});
