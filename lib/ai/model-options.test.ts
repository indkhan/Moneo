import { expect, test } from "vitest";
import { connectedDefault, modelIsConnected, modelOptions } from "./model-options";

test("Claude-only installs offer and default to Claude without OpenAI", () => {
  const connections = { openai: false, claude: true, openrouter: false };
  expect(modelOptions(connections).every(id => id.startsWith("claude-"))).toBe(true);
  expect(connectedDefault("chat", connections, false)).toBe("claude-opus-5-5");
  expect(modelIsConnected("gpt-custom", connections)).toBe(false);
  expect(modelIsConnected("claude-future", connections)).toBe(true);
  expect(modelIsConnected("anthropic/claude-opus-5.5", connections)).toBe(false);
});

test("OpenRouter-only defaults use explicit OpenRouter IDs and combined connections include both catalogs", () => {
  const connections = { openai: false, claude: false, openrouter: true };
  expect(connectedDefault("chat", connections, false)).toBe("openai/gpt-6.1-sol");
  expect(modelOptions(connections).every(id => id.includes("/"))).toBe(true);
  expect(modelOptions({ ...connections, claude: true })).toEqual(expect.arrayContaining(["claude-opus-5-5", "openai/gpt-6.1-sol"]));
  expect(modelOptions({ openai: false, claude: false, openrouter: false })).toEqual([]);
});
