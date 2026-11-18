import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { bankTokenKey } from "@/lib/env";

export function encryptToken(plain: string, connectionId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bankTokenKey(), iv).setAAD(Buffer.from(connectionId));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

export function decryptToken(sealed: string, connectionId: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("Unknown bank token format");
  const bytes = Buffer.from(sealed.slice(3), "base64");
  if (bytes.length < 29) throw new Error("Bank token is truncated");
  const decipher = createDecipheriv("aes-256-gcm", bankTokenKey(), bytes.subarray(0, 12)).setAAD(Buffer.from(connectionId));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}
