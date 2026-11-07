import { serviceKey } from "@/lib/service-keys";
import { chatgptStatus } from "./chatgpt";

/** Whether any AI is set up: a ChatGPT sign-in or an API key. */
export async function aiConfigured() {
  const [openai, openrouter] = await Promise.all([serviceKey("openai_api_key"), serviceKey("openrouter_api_key")]);
  return Boolean(openai || openrouter) || (await chatgptStatus()).signedIn;
}

/** Voice calls, dictation and voice samples need an OpenAI API key: plan usage and OpenRouter have no realtime audio. */
export const voiceApiKey = () => serviceKey("openai_api_key");
