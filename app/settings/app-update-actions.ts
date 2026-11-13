"use server";

import { headers } from "next/headers";
import { requireWorkspace } from "@/lib/auth";
import { desktopUpdate, type UpdateStatus } from "@/lib/desktop-bridge";
import { fromRemoteDevice } from "@/lib/remote-device";

export type AppUpdateState = UpdateStatus & { message?: string };

/** Checks for, installs, or follows an update of Moneo Desktop. Only from the computer it runs on. */
export async function appUpdate(action: "status" | "check" | "install", previous: AppUpdateState): Promise<AppUpdateState> {
  await requireWorkspace();
  if (action !== "status" && fromRemoteDevice(await headers())) return { ...previous, message: "Update Moneo from the computer it runs on." };
  try { return await desktopUpdate(action) ?? { ...previous, message: "Updates are for the Moneo app." }; }
  // While an update installs, Moneo quits and the server stops answering.
  catch { return previous.state === "installing" ? previous : { ...previous, message: "Moneo could not answer. Try again." }; }
}
