"use server";

import { requireWorkspace } from "@/lib/auth";
import { turnOffPhoneAccess, turnOnPhoneAccess, type PhoneAccess } from "@/lib/phone-access";

export type PhoneAccessState = PhoneAccess & { error?: string };

async function attempt(change: () => Promise<PhoneAccess>, previous: PhoneAccessState): Promise<PhoneAccessState> {
  await requireWorkspace();
  try { return await change(); }
  catch (error) {
    console.error("phone access failed", error instanceof Error ? error.message : "unknown error");
    return { ...previous, error: "Tailscale could not make that change. Open Tailscale, check it is connected, and try again." };
  }
}

export const turnOn = async (previous: PhoneAccessState) => attempt(turnOnPhoneAccess, previous);
export const turnOff = async (previous: PhoneAccessState) => attempt(turnOffPhoneAccess, previous);
