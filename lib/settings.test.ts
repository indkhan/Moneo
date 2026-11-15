import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings, settingsSchema, requireAiScope } from "./settings";

describe("workspace preferences", () => {
  it("defaults to EUR-era Germany calendar and explicitly scoped AI data", () => {
    expect(settingsSchema.parse({})).toMatchObject({ timezone: "Europe/Berlin", locale: "en-GB", theme: "system",
      ai_data_scopes: ["accounts", "transactions", "planning", "imports"], summary_cadence: "none" });
  });
  it("rejects invalid timezone, locale, scopes and summary times", () => {
    for (const invalid of [{ timezone: "Moon/Base" }, { locale: "not_a_locale" }, { ai_data_scopes: ["secrets"] }, { summary_time: "25:00" }])
      expect(settingsSchema.safeParse(invalid).success).toBe(false);
  });
  it("defaults the call voice to marin and accepts only GPT-Live voices", () => {
    expect(settingsSchema.parse({}).voice).toBe("marin");
    expect(settingsSchema.parse({ voice: "cedar" }).voice).toBe("cedar");
    for (const voice of ["juniper", "", "MARIN"]) expect(settingsSchema.safeParse({ voice }).success).toBe(false);
  });
  it("lets the voice call model be set separately and rejects unknown agents", () => {
    expect(settingsSchema.parse({ ai_models: { voice_call: "gpt-fast" } }).ai_models).toEqual({ voice_call: "gpt-fast" });
    expect(settingsSchema.safeParse({ ai_models: { phone: "gpt-fast" } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ai_models: { voice_call: " " } }).success).toBe(false);
  });
  it("denies missing provider data permissions", () => {
    const settings = settingsSchema.parse({ ai_data_scopes: ["accounts"] });
    expect(() => requireAiScope(settings, "accounts")).not.toThrow();
    expect(() => requireAiScope(settings, "transactions")).toThrow("AI access to transactions is disabled");
  });
});

describe("stored preferences from another version (issue #224)", () => {
  it("keeps every readable preference and defaults the one it cannot read", () => {
    const stored = { theme: "dark", locale: "de-DE", ai_models: { default: "gpt-6-luna" }, voice: "retired-voice", workspace_id: "w" };
    expect(readSettings(stored)).toEqual({ ...DEFAULT_SETTINGS, theme: "dark", locale: "de-DE" });
  });

  it("reads a missing row as the defaults", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});
