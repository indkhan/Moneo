import { describe, expect, it } from "vitest";
import { CredentialEncryptionError, decryptCredential, encryptCredential } from "./ai-credentials";

const key = Buffer.alloc(32, 7).toString("base64");

describe("AI credential envelope encryption", () => {
  it("round-trips a local credential only in its workspace", async () => {
    const ciphertext = await encryptCredential("sk-test-secret", "workspace-a", {
      environment: "development",
      wrappingKey: key,
    });
    expect(ciphertext).not.toContain("sk-test-secret");
    await expect(
      decryptCredential(ciphertext, "workspace-a", {
        environment: "development",
        wrappingKey: key,
      }),
    ).resolves.toBe("sk-test-secret");
    await expect(
      decryptCredential(ciphertext, "workspace-b", {
        environment: "development",
        wrappingKey: key,
      }),
    ).rejects.toThrow(CredentialEncryptionError);
  });

  it("fails closed without the environment-specific wrapping configuration", async () => {
    await expect(
      encryptCredential("secret", "workspace-a", { environment: "development" }),
    ).rejects.toThrow(CredentialEncryptionError);
    await expect(
      encryptCredential("secret", "workspace-a", { environment: "production", wrappingKey: key }),
    ).rejects.toThrow(CredentialEncryptionError);
  });

  it("rejects local envelopes in staging and detects modified ciphertext", async () => {
    const ciphertext = await encryptCredential("secret", "workspace-a", {
      environment: "development",
      wrappingKey: key,
    });
    await expect(
      decryptCredential(ciphertext, "workspace-a", { environment: "staging", wrappingKey: key }),
    ).rejects.toThrow(CredentialEncryptionError);
    const envelope = JSON.parse(Buffer.from(ciphertext, "base64url").toString()) as {
      ciphertext: string;
    };
    envelope.ciphertext = Buffer.from("tampered").toString("base64url");
    await expect(
      decryptCredential(
        Buffer.from(JSON.stringify(envelope)).toString("base64url"),
        "workspace-a",
        { environment: "development", wrappingKey: key },
      ),
    ).rejects.toThrow(CredentialEncryptionError);
  });

  it("round-trips through KMS with workspace and environment encryption context", async () => {
    const dek = Buffer.alloc(32, 9);
    const wrappedDek = Buffer.from("kms-wrapped-dek");
    const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
    const kms = {
      generateDataKey: (input: Record<string, unknown>) => {
        calls.push({ operation: "generate", input });
        return Promise.resolve({ plaintext: dek, ciphertext: wrappedDek });
      },
      decrypt: (input: Record<string, unknown>) => {
        calls.push({ operation: "decrypt", input });
        const context = input.encryptionContext as Record<string, string>;
        if (context.workspaceId !== "workspace-a") throw new Error("context mismatch");
        return Promise.resolve(dek);
      },
    };
    const options = {
      environment: "staging" as const,
      kmsKeyId: "alias/finance-staging-user-credentials",
      kms,
    };

    const ciphertext = await encryptCredential("sk-kms-secret", "workspace-a", options);
    expect(ciphertext).not.toContain("sk-kms-secret");
    await expect(decryptCredential(ciphertext, "workspace-a", options)).resolves.toBe(
      "sk-kms-secret",
    );
    await expect(decryptCredential(ciphertext, "workspace-b", options)).rejects.toThrow(
      CredentialEncryptionError,
    );
    expect(calls[0]).toEqual({
      operation: "generate",
      input: {
        keyId: "alias/finance-staging-user-credentials",
        encryptionContext: {
          purpose: "user-credentials",
          environment: "staging",
          workspaceId: "workspace-a",
        },
      },
    });
    expect(calls[1]?.input).toMatchObject({
      keyId: "alias/finance-staging-user-credentials",
      encryptionContext: { workspaceId: "workspace-a" },
    });
  });
});
