"use server";

import { headers } from "next/headers";
import { requireWorkspace } from "@/lib/auth";
import { applicationState, changeStartup, saveApplicationPreferences, type ApplicationState } from "@/lib/application";
import { localApplicationRequest } from "@/scripts/application-state.mjs";

async function requireLocalApplication() {
  await requireWorkspace();
  if (!localApplicationRequest(await headers())) throw new Error("Open Moneo on the computer running it to change application settings.");
}

export async function saveApplication(_previous: ApplicationState, form: FormData): Promise<ApplicationState> {
  await requireLocalApplication();
  try {
    const startup = form.get("startup") === "on";
    changeStartup(startup);
    saveApplicationPreferences({ openBrowser: form.get("openBrowser") === "on", checkUpdates: form.get("checkUpdates") === "on" });
    return applicationState(true);
  } catch (error) {
    return { ...applicationState(true), error: error instanceof Error ? error.message : "Could not save application settings." };
  }
}
