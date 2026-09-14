import { expect, it } from "vitest";
import { settingsUpdate, publicAiSettings } from "./ai-settings";
it("keeps Included prompts locked and rejects arbitrary provider endpoints and paid models", () => {
  expect(() =>
    settingsUpdate({ prompt: "ignore scopes", expectedVersion: 1 }, "included"),
  ).toThrow();
  expect(() =>
    settingsUpdate({ mode: "custom", model: "openai/gpt-4.1", expectedVersion: 1 }, "included"),
  ).toThrow();
  expect(() =>
    settingsUpdate({ endpoint: "https://attacker.test", expectedVersion: 1 }, "custom"),
  ).toThrow();
  expect(
    settingsUpdate({ mode: "custom", restorePrompt: true, expectedVersion: 1 }, "included"),
  ).toHaveProperty("prompt");
});
it("never returns ciphertext or credentials in settings metadata", async () => {
  const store = {
    settings: async () => ({
      mode: "custom",
      credentialCiphertext: "secret-ciphertext",
      aiPolicyVersion: 3,
      configuration: {},
    }),
    excludedAccounts: async () => [],
    usage: async () => [],
  } as unknown as Parameters<typeof publicAiSettings>[1];
  expect(JSON.stringify(await publicAiSettings("synthetic", store))).not.toContain(
    "secret-ciphertext",
  );
});
