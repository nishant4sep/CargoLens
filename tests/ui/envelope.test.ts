/**
 * PURE — the client-side envelope parser (src/lib/envelope.ts). No DOM, no
 * fetch: construct Response objects directly. These pin the ONE contract the
 * UI has for every API reply, including the ugly edge cases.
 */
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "@/lib/envelope";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseEnvelope — success responses", () => {
  it("2xx JSON body passes through as data", async () => {
    const r = await parseEnvelope<{ user: { role: string } }>(
      jsonRes({ user: { role: "MANAGER" } }, 200),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.user.role).toBe("MANAGER");
    expect(r.status).toBe(200);
  });

  it("201 with a payload body is still success", async () => {
    const r = await parseEnvelope(jsonRes({ document: { id: "d1" } }, 201));
    expect(r.ok).toBe(true);
  });

  it("2xx with an EMPTY body resolves data null (no throw)", async () => {
    const r = await parseEnvelope(new Response(null, { status: 204 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBeNull();
  });
});

describe("parseEnvelope — error envelopes", () => {
  it("maps the contract envelope to { code, message }", async () => {
    const r = await parseEnvelope(
      jsonRes({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } }, 401),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNAUTHENTICATED");
      expect(r.error.message).toBe("Sign in required");
      expect(r.status).toBe(401);
    }
  });

  it("keeps `details` (e.g. the export gate's missing-criteria list)", async () => {
    const details = { issues: ["grossWeight mismatch"] };
    const r = await parseEnvelope(
      jsonRes({ error: { code: "CONFLICT", message: "Gate failed", details } }, 409),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details).toEqual(details);
  });

  it("non-JSON error body (crashed proxy) → opaque INTERNAL, real status kept", async () => {
    const r = await parseEnvelope(new Response("<html>boom</html>", { status: 502 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toBe("Unexpected server error");
      expect(r.status).toBe(502);
    }
  });

  it("error envelope with missing fields degrades to safe defaults", async () => {
    const r = await parseEnvelope(jsonRes({ error: {} }, 400));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INTERNAL");
      expect(r.error.message).toBe("Unexpected server error");
    }
  });
});
