"use server";

import { headers } from "next/headers";
import { advanceDesktopUpdate, type AppUpdate } from "@/lib/app-update";
import { requireWorkspace } from "@/lib/auth";
import { fromRemoteDevice } from "@/lib/remote-device";

export async function installAppUpdate(): Promise<{ update?: AppUpdate | null; message?: string }> {
  await requireWorkspace();
  if (fromRemoteDevice(await headers())) return { message: "Update Moneo from the computer it runs on." };
  try { return { update: await advanceDesktopUpdate() }; }
  catch { return { message: "Moneo could not answer. Try again." }; }
}
