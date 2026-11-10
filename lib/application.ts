import { z } from "zod";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationDirectory, launcherRequest, preferences, readJson, setStartup, startupEnabled, writeJson } from "@/scripts/application-state.mjs";
import { checkRelease, commitPattern, releaseTagPattern } from "@/scripts/application-releases.mjs";

export const applicationPreferencesSchema = z.object({ openBrowser: z.boolean(), checkUpdates: z.boolean() });
export const updateTargetSchema = z.object({ tag: z.string().regex(releaseTagPattern), sha: z.string().regex(commitPattern) });
export type ApplicationState = {
  startup: boolean;
  supported: boolean;
  local: boolean;
  openBrowser: boolean;
  checkUpdates: boolean;
  version: string;
  managed: boolean;
  release: { tag: string; sha: string; name: string; notes: string; url: string } | null;
  checkedAt: number | null;
  updateError?: string;
  error?: string;
};

export async function applicationState(local: boolean): Promise<ApplicationState> {
  const supported = ["win32", "darwin", "linux"].includes(process.platform);
  const saved = applicationPreferencesSchema.parse(preferences(process.cwd()));
  let version = "Unknown checkout", managed = false;
  try { version = (await promisify(execFile)("git", ["describe", "--tags", "--always"], { cwd: process.cwd(), timeout: 3000, windowsHide: true })).stdout.trim(); } catch { /* Source archives may not contain Git metadata. */ }
  try { managed = ["ready", "restored"].includes((await launcherRequest(process.cwd())).phase); } catch { /* npm run dev and QA do not use the launcher. */ }
  const cached = readJson(join(applicationDirectory(process.cwd()), "release.json"));
  let current = "";
  try { current = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), timeout: 3000, windowsHide: true })).stdout.trim(); } catch { /* No Git checkout. */ }
  return { ...saved, supported, local, version, managed, startup: supported && startupEnabled(process.cwd()), release: cached?.release?.sha === current ? null : cached?.release ?? null, checkedAt: cached?.checkedAt ?? null, updateError: cached?.error ?? undefined };
}

export function saveApplicationPreferences(input: unknown) {
  const saved = applicationPreferencesSchema.parse(input);
  writeJson(join(applicationDirectory(process.cwd()), "preferences.json"), saved);
}

export function changeStartup(enabled: boolean) {
  if (process.env.NEXT_DIST_DIR || process.env.PORT === "3100") throw new Error("Startup changes are disabled on the test server.");
  setStartup(process.cwd(), z.boolean().parse(enabled));
  if (enabled) writeJson(join(applicationDirectory(process.cwd()), "startup.json"), { port: Number(process.env.PORT || 3000) });
}

export async function checkApplicationRelease() { return checkRelease(process.cwd(), true); }
