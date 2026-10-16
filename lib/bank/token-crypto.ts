import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for Enable Banking session ids at rest. The connection id is bound as
// associated data, so a ciphertext copied onto another connection row fails to decrypt.
function key(): Buffer {
  const raw = process.env.BANK_TOKEN_ENCRYPTION_KEY;
  const decoded = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (decoded.length !== 32) throw new Error("BANK_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return decoded;
}

export function encryptToken(plain: string, connectionId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv).setAAD(Buffer.from(connectionId));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

export function decryptToken(sealed: string, connectionId: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("Unknown bank token format");
  const bytes = Buffer.from(sealed.slice(3), "base64");
  if (bytes.length < 29) throw new Error("Bank token is truncated");
  const decipher = createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12)).setAAD(Buffer.from(connectionId));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
