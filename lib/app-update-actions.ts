"use server";

import { cookies, headers } from "next/headers";
import { advanceDesktopUpdate, UPDATE_CHECKS_COOKIE, type AppUpdate } from "@/lib/app-update";
import { requireWorkspace } from "@/lib/auth";
import { fromRemoteDevice } from "@/lib/remote-device";

export async function installAppUpdate(): Promise<{ update?: AppUpdate | null; message?: string }> {
  await requireWorkspace();
  if (fromRemoteDevice(await headers())) return { message: "Update Moneo from the computer it runs on." };
  if ((await cookies()).get(UPDATE_CHECKS_COOKIE)?.value !== "1") return { message: "Enable update checks in Settings first." };
  try { return { update: await advanceDesktopUpdate() }; }
  catch { return { message: "Moneo could not answer. Try again." }; }
}
