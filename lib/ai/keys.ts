// Cheap calls that prove a pasted key works before it is saved. Neither uses tokens.
const CHECKS = {
  openai_api_key: { provider: "OpenAI", url: "https://api.openai.com/v1/models" },
  openrouter_api_key: { provider: "OpenRouter", url: "https://openrouter.ai/api/v1/key" },
} as const;
export type AiKeyName = keyof typeof CHECKS;
export const isAiKeyName = (value: unknown): value is AiKeyName => typeof value === "string" && value in CHECKS;

/** null when the provider accepts the key, else a message for the owner. */
export async function checkAiKey(name: AiKeyName, key: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const { provider, url } = CHECKS[name];
  const response = await fetcher(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!response) return `Couldn't reach ${provider} to check the key. Check your connection and try again.`;
  if (response.ok) return null;
  if (response.status === 401 || response.status === 403) return `${provider} didn't accept that key. Check it and try again.`;
  return `${provider} couldn't check the key right now (${response.status}). Try again.`;
}
