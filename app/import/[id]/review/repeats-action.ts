"use server";

import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { findWaitingRepeats } from "@/lib/import/repeats";
import { safely, type SafeState } from "@/lib/safe-action";

/** Worked out again here, so a row decided or changed since the page loaded isn't touched. Each row keeps its review history and undo. */
async function resolveRepeats() {
  const { supabase, workspace } = await requireWorkspace();
  for (const { sourceId } of await findWaitingRepeats(supabase, workspace.id)) {
    const { error } = await supabase.rpc("resolve_normalized_import_review", { p_source_id: sourceId, p_action: "reject" });
    if (error) throw new Error(error.message);
  }
  revalidatePath("/", "layout");
}

export async function resolveRepeatsSafely(_state: SafeState, form: FormData) { return safely(form, resolveRepeats); }
