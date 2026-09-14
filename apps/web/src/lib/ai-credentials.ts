import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { z } from "zod";

export interface CredentialKms {
  generateDataKey(input: {
    keyId: string;
    encryptionContext: Record<string, string>;
  }): Promise<{ plaintext: Uint8Array; ciphertext: Uint8Array }>;
  decrypt(input: {
    keyId: string;
    ciphertext: Uint8Array;
    encryptionContext: Record<string, string>;
  }): Promise<Uint8Array>;
}

export interface CredentialEncryptionOptions {
  environment: "development" | "test" | "staging" | "production";
  wrappingKey?: string;
  kmsKeyId?: string;
  kms?: CredentialKms;
}

interface LocalEnvelope {
  v: 1;
  wrappedDek: string;
  wrapIv: string;
  wrapTag: string;
  ciphertext: string;
  dataIv: string;
  dataTag: string;
}

interface KmsEnvelope {
  v: 2;
  provider: "aws-kms";
  wrappedDek: string;
  ciphertext: string;
  dataIv: string;
  dataTag: string;
}

type Envelope = LocalEnvelope | KmsEnvelope;
const encryptedFields = {
  wrappedDek: z.string(),
  ciphertext: z.string(),
  dataIv: z.string(),
  dataTag: z.string(),
};
const envelopeSchema = z.discriminatedUnion("v", [
  z
    .object({ v: z.literal(1), ...encryptedFields, wrapIv: z.string(), wrapTag: z.string() })
    .strict(),
  z.object({ v: z.literal(2), provider: z.literal("aws-kms"), ...encryptedFields }).strict(),
]);

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialEncryptionError";
  }
}

function encode(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CredentialEncryptionError("Credential envelope is malformed.");
  }
  return Buffer.from(value, "base64url");
}

function wrappingKey(options: CredentialEncryptionOptions): Buffer {
  if (options.environment === "production" || options.environment === "staging") {
    throw new CredentialEncryptionError("A production KMS credential wrapper is required.");
  }
  if (!options.wrappingKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(options.wrappingKey)) {
    throw new CredentialEncryptionError("AI credential encryption key is not configured.");
  }
  const key = Buffer.from(options.wrappingKey, "base64");
  if (key.length !== 32) {
    throw new CredentialEncryptionError(
      "AI credential encryption key must be a base64-encoded 32-byte key.",
    );
  }
  return key;
}

function seal(
  key: Buffer,
  plaintext: Buffer,
  aad: string,
): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return {
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    iv,
    tag: cipher.getAuthTag(),
  };
}

function open(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer, aad: string): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CredentialEncryptionError("Credential cannot be decrypted for this workspace.");
  }
}

function encryptionContext(environment: string, workspaceId: string): Record<string, string> {
  return { purpose: "user-credentials", environment, workspaceId };
}

function configuredKms(options: CredentialEncryptionOptions): {
  keyId: string;
  client: CredentialKms;
} {
  if (!options.kmsKeyId)
    throw new CredentialEncryptionError("AI credential KMS key is not configured.");
  return { keyId: options.kmsKeyId, client: options.kms ?? awsKms() };
}

function awsKms(): CredentialKms {
  const client = new KMSClient({});
  return {
    async generateDataKey({ keyId, encryptionContext: context }) {
      const output = await client.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: "AES_256",
          EncryptionContext: context,
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      if (!output.Plaintext || !output.CiphertextBlob)
        throw new CredentialEncryptionError("KMS did not return a complete data key.");
      return { plaintext: output.Plaintext, ciphertext: output.CiphertextBlob };
    },
    async decrypt({ keyId, ciphertext, encryptionContext: context }) {
      const output = await client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: ciphertext,
          EncryptionContext: context,
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      if (!output.Plaintext)
        throw new CredentialEncryptionError("KMS did not return a plaintext data key.");
      return output.Plaintext;
    },
  };
}

/** Encrypt a provider credential under a fresh per-record DEK, bound to one workspace. */
export async function encryptCredential(
  credential: string,
  workspaceId: string,
  options: CredentialEncryptionOptions,
): Promise<string> {
  if (!credential || !workspaceId) {
    throw new CredentialEncryptionError("Credential and workspace are required.");
  }
  if (options.environment === "staging" || options.environment === "production") {
    const { keyId, client } = configuredKms(options);
    try {
      const generated = await client.generateDataKey({
        keyId,
        encryptionContext: encryptionContext(options.environment, workspaceId),
      });
      const dek = Buffer.from(generated.plaintext);
      if (dek.length !== 32)
        throw new CredentialEncryptionError("KMS returned an invalid data key.");
      try {
        const encrypted = seal(
          dek,
          Buffer.from(credential, "utf8"),
          `moneo.ai-credential.workspace.${workspaceId}`,
        );
        return encode(
          Buffer.from(
            JSON.stringify({
              v: 2,
              provider: "aws-kms",
              wrappedDek: encode(Buffer.from(generated.ciphertext)),
              ciphertext: encode(encrypted.ciphertext),
              dataIv: encode(encrypted.iv),
              dataTag: encode(encrypted.tag),
            } satisfies KmsEnvelope),
            "utf8",
          ),
        );
      } finally {
        dek.fill(0);
      }
    } catch (error) {
      if (error instanceof CredentialEncryptionError) throw error;
      throw new CredentialEncryptionError("KMS could not encrypt the AI credential.");
    }
  }
  const kek = wrappingKey(options);
  const dek = randomBytes(32);
  const wrapped = seal(kek, dek, "moneo.ai-credential.dek.v1");
  const encrypted = seal(
    dek,
    Buffer.from(credential, "utf8"),
    `moneo.ai-credential.workspace.${workspaceId}`,
  );
  const envelope: Envelope = {
    v: 1,
    wrappedDek: encode(wrapped.ciphertext),
    wrapIv: encode(wrapped.iv),
    wrapTag: encode(wrapped.tag),
    ciphertext: encode(encrypted.ciphertext),
    dataIv: encode(encrypted.iv),
    dataTag: encode(encrypted.tag),
  };
  return encode(Buffer.from(JSON.stringify(envelope), "utf8"));
}

/** Decrypt using the environment-specific wrapper; local envelopes stay local. */
export async function decryptCredential(
  value: string,
  workspaceId: string,
  options: CredentialEncryptionOptions,
): Promise<string> {
  if (!workspaceId) {
    throw new CredentialEncryptionError("Workspace is required.");
  }
  let envelope: Envelope;
  try {
    envelope = envelopeSchema.parse(JSON.parse(decode(value).toString("utf8")));
  } catch (error) {
    if (error instanceof CredentialEncryptionError) throw error;
    throw new CredentialEncryptionError("Credential envelope is malformed.");
  }
  if (envelope.v === 2) {
    if (options.environment !== "staging" && options.environment !== "production")
      throw new CredentialEncryptionError(
        "Credential envelope cannot be decrypted in this environment.",
      );
    const { keyId, client } = configuredKms(options);
    try {
      const dek = Buffer.from(
        await client.decrypt({
          keyId,
          ciphertext: decode(envelope.wrappedDek),
          encryptionContext: encryptionContext(options.environment, workspaceId),
        }),
      );
      if (dek.length !== 32)
        throw new CredentialEncryptionError("KMS returned an invalid data key.");
      try {
        return open(
          dek,
          decode(envelope.ciphertext),
          decode(envelope.dataIv),
          decode(envelope.dataTag),
          `moneo.ai-credential.workspace.${workspaceId}`,
        ).toString("utf8");
      } finally {
        dek.fill(0);
      }
    } catch (error) {
      if (error instanceof CredentialEncryptionError) throw error;
      throw new CredentialEncryptionError("Credential cannot be decrypted for this workspace.");
    }
  }
  const kek = wrappingKey(options);
  const dek = open(
    kek,
    decode(envelope.wrappedDek),
    decode(envelope.wrapIv),
    decode(envelope.wrapTag),
    "moneo.ai-credential.dek.v1",
  );
  return open(
    dek,
    decode(envelope.ciphertext),
    decode(envelope.dataIv),
    decode(envelope.dataTag),
    `moneo.ai-credential.workspace.${workspaceId}`,
  ).toString("utf8");
}
