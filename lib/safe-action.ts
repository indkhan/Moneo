import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { readableError } from "@/lib/ai/agent-apply";

export type SafeState = { error?: string };

/** Runs a form action so a refusal comes back as a message for the form, not the error page. Redirects still happen. */
export async function safely(form: FormData, action: (form: FormData) => Promise<unknown>): Promise<SafeState> {
  try {
    await action(form);
    return {};
  } catch (cause) {
    unstable_rethrow(cause);
    if (cause instanceof z.ZodError) return { error: cause.issues[0]?.message ?? "Check the form and try again" };
    return { error: readableError(cause) };
  }
}
