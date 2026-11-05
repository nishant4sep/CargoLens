/**
 * Private document storage (Phase 4, plan D-1) — local private disk TODAY,
 * Supabase Storage in Phase 7. This module is the ENTIRE seam: three functions
 * + two token helpers. The swap rewrites only these internals; the #11 contract
 * (302 → signed URL), the DB columns, and the UI never change.
 *
 * Security model (06 §1.3 / PRD §9):
 *  - storage names are server-generated UUIDs — no user-provided string ever
 *    joins a file path;
 *  - the directory is gitignored and outside `public/` — nothing is servable
 *    by the web server by accident;
 *  - reads go through 5-minute HMAC-signed tokens (the S3-presigned model:
 *    possession of an unguessable, expiring URL = capability);
 *  - every write is content-hashed (sha256) for integrity evidence;
 *  - env overrides: STORAGE_DIR (dev default `./.storage`); the Phase-7 driver
 *    will read the STORAGE_* placeholders already reserved in `.env`.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** HMAC key for file tokens — same trust domain as the session secret. */
function tokenSecret(): string {
  const s = process.env.AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET/BETTER_AUTH_SECRET must be set to sign file tokens");
  return s;
}

function storageDir(): string {
  // Read at CALL time (not import time) so tests can redirect storage to a temp dir.
  return process.env.STORAGE_DIR || path.join(process.cwd(), ".storage");
}

/** Only server-generated names may ever reach the filesystem layer. */
function assertSafeStoredName(name: string): void {
  if (!/^[0-9a-fA-F-]{36}\.bin$/.test(name)) throw new Error("Unsafe storage name rejected");
}

export interface StoredDocument {
  storagePath: string; // opaque `local://<uuid>.bin` — never a user-visible path
  sha256Hex: string;
  sizeBytes: bigint;
}

/** Randomized-name write + content hash. Callers own orphan cleanup on failure. */
export async function putDocument(buffer: Buffer): Promise<StoredDocument> {
  const dir = storageDir();
  await mkdir(dir, { recursive: true });
  const name = `${randomUUID()}.bin`;
  await writeFile(path.join(dir, name), buffer);
  return {
    storagePath: `local://${name}`,
    sha256Hex: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: BigInt(buffer.length),
  };
}

/** Orphan cleanup (storage written, row failed) — best-effort by design. */
export async function removeDocument(storagePath: string): Promise<void> {
  if (!storagePath.startsWith("local://")) return;
  const name = storagePath.slice("local://".length);
  assertSafeStoredName(name);
  await unlink(path.join(storageDir(), name)).catch(() => undefined);
}

/** Bytes for a stored document, or null when the file is missing from disk. */
export async function openDocument(storagePath: string): Promise<Buffer | null> {
  if (!storagePath.startsWith("local://")) return null;
  const name = storagePath.slice("local://".length);
  assertSafeStoredName(name);
  try {
    return await readFile(path.join(storageDir(), name));
  } catch {
    return null; // DB row exists, file gone → caller decides (integrity error)
  }
}

/* ---------------- signed file tokens (the "presigned URL" of the local driver) ---------------- */

export interface FileTokenPayload {
  documentId: string;
  exp: number; // unix seconds
}

export function signFileToken(documentId: string, ttlSeconds = 300): string {
  const payload: FileTokenPayload = { documentId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** null on ANY failure: malformed, forged, or expired — the route maps that to 403. */
export function verifyFileToken(token: string): FileTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as FileTokenPayload;
    if (typeof payload.documentId !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
