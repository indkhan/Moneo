import { serviceKey } from "@/lib/service-keys";
import { chatgptStatus } from "./chatgpt";
import { claudeAccount } from "./claude";

export async function aiConfigured() {
  const [openai, openrouter, chatgpt] = await Promise.all([serviceKey("openai_api_key"), serviceKey("openrouter_api_key"), chatgptStatus()]);
  return Boolean(openai || openrouter) || chatgpt.signedIn || (chatgpt.source === "claude" && (await claudeAccount()).signedIn);
}

export const voiceApiKey = () => serviceKey("openai_api_key");
