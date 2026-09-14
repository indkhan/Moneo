import { createAiStore, type AiSettingsUpdate } from "@moneo/db";
import { financialAssistant } from "@moneo/ai";
import { z } from "zod";
const models = financialAssistant.modelPolicy.allowedModels;
export const aiSettingsInput = z
  .object({
    mode: z.enum(["included", "custom"]).optional(),
    model: z.enum(models).optional(),
    prompt: z.string().max(2000).optional(),
    restorePrompt: z.boolean().optional(),
    excludedAccountIds: z.array(z.uuid()).max(1000).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export async function publicAiSettings(wid: string, store = createAiStore()) {
  const cfg = await store.settings(wid);
  return {
    mode: cfg.mode,
    model: cfg.mode === "included" ? models[0] : (cfg.configuration.model ?? models[0]),
    models,
    prompt:
      cfg.mode === "included"
        ? financialAssistant.prompt
        : (cfg.configuration.prompt ?? financialAssistant.prompt),
    defaultPrompt: financialAssistant.prompt,
    policyVersion: cfg.aiPolicyVersion,
    credentialConnected: cfg.credentialCiphertext !== null,
    includedConnected: !!process.env.OPENROUTER_API_KEY,
    accounts: await store.excludedAccounts(wid),
    usage: await store.usage(wid),
  };
}
export function settingsUpdate(
  value: unknown,
  currentMode: "included" | "custom",
): AiSettingsUpdate {
  const input = aiSettingsInput.parse(value);
  const mode = input.mode ?? currentMode;
  if (
    mode === "included" &&
    (input.model !== undefined || input.prompt !== undefined || input.restorePrompt)
  )
    throw new Error("Included AI models and prompts are read-only");
  const { restorePrompt, ...rest } = input;
  return { ...rest, ...(restorePrompt ? { prompt: financialAssistant.prompt } : {}) };
}
