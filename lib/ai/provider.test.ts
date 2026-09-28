import { afterEach, expect, test, vi } from "vitest";
import { getModel } from "./provider";

afterEach(() => vi.unstubAllEnvs());

test("accepts the configured OpenRouter model without a suffix restriction", () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_MODEL", "example/model");
  expect(getModel().modelId).toBe("example/model");
});
