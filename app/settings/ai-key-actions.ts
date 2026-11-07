"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { checkAiKey, isAiKeyName } from "@/lib/ai/keys";
import { removeServiceKeys, saveServiceKeys } from "@/lib/service-keys";

export type AiKeyState = { error?: string; saved?: boolean };
const keySchema = z.string().trim().min(8, "Paste the whole key").max(500, "That key is too long").regex(/^\S+$/, "A key has no spaces");

// Saves an OpenAI or OpenRouter key after the provider accepts it, or removes the saved one.
export async function saveAiKey(_: AiKeyState, form: FormData): Promise<AiKeyState> {
  await requireWorkspace();
  const name = form.get("name");
  if (!isAiKeyName(name)) return { error: "Unknown key" };
  if (form.get("operation") === "remove") {
    try { await removeServiceKeys([name]); } catch (error) { return { error: error instanceof Error ? error.message : "The key could not be removed" }; }
    revalidatePath("/", "layout");
    return {};
  }
  const key = keySchema.safeParse(form.get("key"));
  if (!key.success) return { error: key.error.issues[0].message };
  const problem = await checkAiKey(name, key.data);
  if (problem) return { error: problem };
  try { await saveServiceKeys({ [name]: key.data }); } catch (error) { return { error: error instanceof Error ? error.message : "The key could not be saved" }; }
  revalidatePath("/", "layout");
  return { saved: true };
}
