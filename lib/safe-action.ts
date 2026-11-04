import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { readableError } from "@/lib/ai/agent-apply";

export type SafeState = { error?: string };

/** "Transaction changed; refresh and retry" and its kin: someone saved first. Conflicts with their own next step, such as "undo latest correction first", keep their wording. */
const STALE_VERSION = /\bchanged(; (refresh|reload|retry)\b.*)?$/i;
const STALE_GUIDANCE = "This changed since you opened it. Refresh and review it, then try again.";

/** Runs a form action so a refusal comes back as a message for the form, not the error page. Redirects still happen. */
export async function safely(form: FormData, action: (form: FormData) => Promise<unknown>): Promise<SafeState> {
  try {
    await action(form);
    return {};
  } catch (cause) {
    unstable_rethrow(cause);
    if (cause instanceof z.ZodError) return { error: cause.issues[0]?.message ?? "Check the form and try again" };
    const error = readableError(cause);
    return { error: STALE_VERSION.test(error) ? STALE_GUIDANCE : error };
  }
}
