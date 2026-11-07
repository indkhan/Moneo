import { chatgptStatus } from "./chatgpt";

/** Whether any AI is set up: a ChatGPT sign-in or an API key. */
export async function aiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY) || (await chatgptStatus()).signedIn;
}
