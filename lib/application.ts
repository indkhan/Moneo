import { z } from "zod";
import { join } from "node:path";
import { applicationDirectory, preferences, setStartup, startupEnabled, writeJson } from "@/scripts/application-state.mjs";

export const applicationPreferencesSchema = z.object({ openBrowser: z.boolean(), checkUpdates: z.boolean() });
export type ApplicationState = {
  startup: boolean;
  supported: boolean;
  local: boolean;
  openBrowser: boolean;
  checkUpdates: boolean;
  error?: string;
};

export function applicationState(local: boolean): ApplicationState {
  const supported = ["win32", "darwin", "linux"].includes(process.platform);
  const saved = applicationPreferencesSchema.parse(preferences(process.cwd()));
  return { ...saved, supported, local, startup: supported && startupEnabled(process.cwd()) };
}

export function saveApplicationPreferences(input: unknown) {
  const saved = applicationPreferencesSchema.parse(input);
  writeJson(join(applicationDirectory(process.cwd()), "preferences.json"), saved);
}

export function changeStartup(enabled: boolean) {
  if (process.env.NEXT_DIST_DIR || process.env.PORT === "3100") throw new Error("Startup changes are disabled on the test server.");
  setStartup(process.cwd(), z.boolean().parse(enabled));
}
