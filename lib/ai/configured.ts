import { serviceKey } from "@/lib/service-keys";
import { chatgptStatus } from "./chatgpt";
import { claudeAccount } from "./claude";

/** Whether any AI is set up: a ChatGPT sign-in, a Claude plan chosen in Settings, or an API key. */
export async function aiConfigured() {
  const [openai, openrouter, chatgpt] = await Promise.all([serviceKey("openai_api_key"), serviceKey("openrouter_api_key"), chatgptStatus()]);
  if (chatgpt.source === "claude") return (await claudeAccount()).signedIn;
  return Boolean(openai || openrouter) || chatgpt.signedIn;
}

/** Voice calls, dictation and voice samples need an OpenAI API key: plan usage, Claude and OpenRouter have no realtime audio. */
export const voiceApiKey = () => serviceKey("openai_api_key");
