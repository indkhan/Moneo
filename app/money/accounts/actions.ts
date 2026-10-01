"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

const version = z.coerce.number().int().min(1).max(2147483646);
const accountType = z.enum(["checking", "savings", "cash", "credit", "investment", "wallet", "other"]);

export async function editAccount(_state: { error?: string }, form: FormData): Promise<{ error?: string }> {
  try {
  const { supabase } = await requireWorkspace();
  const patch = form.get("operation") === "archive" ? { archived: true }
    : form.get("operation") === "restore" ? { archived: false }
    : { name: z.string().trim().min(1).max(120).parse(form.get("name")), type: accountType.parse(form.get("type")) };
  const { error } = await supabase.rpc("edit_money_metadata", {
    p_entity_type: "account", p_id: z.uuid().parse(form.get("accountId")),
    p_expected_version: version.parse(form.get("version")), p_patch: patch, p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not update account" };
  }
  revalidatePath("/", "layout");
  redirect("/money/accounts");
}

export async function undoMoneyMetadata(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_money_metadata", {
    p_event_id: z.uuid().parse(form.get("eventId")), p_expected_version: version.parse(form.get("version")),
    p_request_id: z.uuid().parse(form.get("requestId")),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout");
  redirect("/money/accounts");
}
