import { expect, it, vi } from "vitest";
import { checkAiKey } from "./keys";

it("checks an OpenAI key against the models list", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  expect(await checkAiKey("openai_api_key", "sk-test", fetcher)).toBeNull();
  expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
  expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer sk-test");
});

it("checks an OpenRouter key against its key endpoint and explains failures", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 401 })).mockResolvedValueOnce(new Response("{}", { status: 500 })).mockRejectedValueOnce(new Error("offline"));
  expect(await checkAiKey("openrouter_api_key", "sk-or", fetcher)).toBe("OpenRouter didn't accept that key. Check it and try again.");
  expect(fetcher.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/key");
  expect(await checkAiKey("openrouter_api_key", "sk-or", fetcher)).toMatch(/\(500\)/);
  expect(await checkAiKey("openrouter_api_key", "sk-or", fetcher)).toMatch(/Couldn't reach OpenRouter/);
});
