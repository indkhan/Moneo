"use server";

import { headers } from "next/headers";
import { requireWorkspace } from "@/lib/auth";
import { applicationState, changeStartup, checkApplicationRelease, saveApplicationPreferences, updateTargetSchema, type ApplicationState } from "@/lib/application";
import { launcherRequest, localApplicationRequest } from "@/scripts/application-state.mjs";

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
    return { ...await applicationState(true), error: error instanceof Error ? error.message : "Could not save application settings." };
  }
}

export async function checkApplicationUpdate(): Promise<ApplicationState> {
  await requireLocalApplication();
  await checkApplicationRelease();
  return applicationState(true);
}

export async function installApplicationUpdate(input: unknown): Promise<{ url?: string; error?: string }> {
  await requireLocalApplication();
  if (process.env.NEXT_DIST_DIR || process.env.PORT === "3100") return { error: "Updates are disabled on the test server." };
  try {
    const result = await launcherRequest(process.cwd(), "/update", updateTargetSchema.parse(input));
    return { url: result.url };
  } catch (error) { return { error: error instanceof Error ? error.message : "Could not start the update." }; }
}
