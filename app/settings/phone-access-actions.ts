"use server";

import { requireWorkspace } from "@/lib/auth";
import { TailscaleError, turnOffPhoneAccess, turnOnPhoneAccess, type PhoneAccess } from "@/lib/phone-access";
import { logError } from "@/lib/log";

export type PhoneAccessState = PhoneAccess & { error?: string };

async function attempt(change: () => Promise<PhoneAccess>, previous: PhoneAccessState): Promise<PhoneAccessState> {
  await requireWorkspace();
  try { return await change(); }
  catch (error) {
    logError("server", "phone_access_failed", "phone access failed", error instanceof Error ? error.message : "unknown error");
    return { ...previous, error: error instanceof TailscaleError ? `Tailscale said: ${error.message}` : "Tailscale could not make that change. Open Tailscale, check it is connected, and try again." };
  }
}

export const turnOn = async (previous: PhoneAccessState) => attempt(turnOnPhoneAccess, previous);
export const turnOff = async (previous: PhoneAccessState) => attempt(turnOffPhoneAccess, previous);
