import { createAiStore } from "@moneo/db";
import { createOpenRouterGateway, financialAssistant } from "@moneo/ai";
import { loadEnv } from "@moneo/shared/env";
import { aiRoute, readAiBody } from "@/lib/ai-api";
import { requireFreshAuth, FreshAuthError } from "@/lib/fresh-auth";
import { requireAiOwner } from "@/lib/ai-admin";
import {
  encryptCredential,
  decryptCredential,
  CredentialEncryptionError,
} from "@/lib/ai-credentials";
import { z } from "zod";
const schema = z
  .object({
    action: z.enum(["connect", "test", "revoke"]),
    apiKey: z.string().trim().min(10).max(512).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export async function POST(request: Request) {
  return aiRoute(async (wid, userId) => {
    const input = schema.parse(await readAiBody(request));
    await requireAiOwner(wid, userId);
    try {
      await requireFreshAuth();
      const store = createAiStore(),
        cfg = await store.settings(wid),
        env = loadEnv();
      if (input.expectedVersion !== cfg.aiPolicyVersion)
        return Response.json(
          { message: "AI settings changed. Reload before updating credentials." },
          { status: 409 },
        );
      const options = {
        environment: env.APP_ENV,
        ...(env.AI_CREDENTIAL_ENCRYPTION_KEY
          ? { wrappingKey: env.AI_CREDENTIAL_ENCRYPTION_KEY }
          : {}),
        ...(env.AI_CREDENTIAL_KMS_KEY_ID ? { kmsKeyId: env.AI_CREDENTIAL_KMS_KEY_ID } : {}),
      };
      if (input.action === "revoke")
        await store.updateSettings(wid, {
          credentialCiphertext: null,
          expectedVersion: input.expectedVersion,
        });
      else {
        const key =
          input.action === "connect"
            ? input.apiKey
            : cfg.credentialCiphertext
              ? await decryptCredential(cfg.credentialCiphertext, wid, options)
              : undefined;
        if (!key)
          return Response.json(
            { message: "Provide or connect an OpenRouter key." },
            { status: 400 },
          );
        // Validate envelope configuration before sending even a synthetic request.
        const ciphertext =
          input.action === "connect" ? await encryptCredential(key, wid, options) : undefined;
        await createOpenRouterGateway({ apiKey: key }).generate({
          model: financialAssistant.modelPolicy.allowedModels[0],
          messages: [{ role: "user", content: "Reply: connection verified" }],
          maxOutputTokens: 30,
          signal: AbortSignal.timeout(15000),
        });
        if (ciphertext)
          await store.updateSettings(wid, {
            credentialCiphertext: ciphertext,
            expectedVersion: input.expectedVersion,
          });
      }
      return Response.json({ connected: input.action !== "revoke" });
    } catch (error) {
      if (error instanceof FreshAuthError)
        return Response.json(
          {
            message: "Sign in again to connect, rotate, test or revoke a provider key.",
            reauthenticateUrl: error.reauthenticateUrl,
          },
          { status: 403 },
        );
      if (error instanceof CredentialEncryptionError)
        return Response.json({ message: error.message }, { status: 503 });
      return Response.json(
        {
          message:
            "OpenRouter connection failed. Check your key, free-model quota, and privacy settings.",
        },
        { status: 502 },
      );
    }
  });
}
