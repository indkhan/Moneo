import "server-only";
import { z } from "zod";
import { desktopUpdate, isDesktop, type UpdateStatus } from "@/lib/desktop-bridge";
import { isDesktopPreview, moneoVersion } from "@/lib/env";

export const UPDATE_CHECKS_COOKIE = "moneo-update-checks";

const RELEASES = "https://github.com/indkhan/Moneo/releases";
const LATEST_RELEASE = "https://api.github.com/repos/indkhan/Moneo/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60_000;

type Offer = { current: string; latest: string; notes: string; url: string };
export type AppUpdate = Offer & (
  | { kind: "source" }
  | { kind: "desktop"; state: "available" | "downloading" | "downloaded" | "installing" | "error"; percent?: number; error?: string; installs: boolean }
);

const versionParts = (version: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);

export function isNewerVersion(latest: string, current: string) {
  const next = versionParts(latest), running = versionParts(current);
  if (!next || !running) return false;
  const first = next.findIndex((part, index) => part !== running[index]);
  return first >= 0 && (next[first] ?? 0) > (running[first] ?? 0);
}

const offer = (current: string, latest: string, notes: string): Offer =>
  ({ current, latest, notes: notes.trim(), url: `${RELEASES}/tag/v${encodeURIComponent(latest)}` });

const publishedRelease = z.object({ tag_name: z.string(), body: z.string().nullish() });
const releaseCheckFailedSoNoPillShows = () => null;
let published: { checkedAt: number; release: Promise<z.infer<typeof publishedRelease> | null> } | undefined;

async function fetchPublishedRelease() {
  const response = await fetch(LATEST_RELEASE, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return publishedRelease.parse(await response.json());
}

async function sourceUpdate(): Promise<AppUpdate | null> {
  const current = moneoVersion();
  if (!current) return null;
  if (!published || Date.now() - published.checkedAt >= CHECK_EVERY_MS)
    published = { checkedAt: Date.now(), release: fetchPublishedRelease().catch(releaseCheckFailedSoNoPillShows) };
  const release = await published.release;
  if (!release || !isNewerVersion(release.tag_name, current)) return null;
  return { kind: "source", ...offer(current, release.tag_name.replace(/^v/, ""), release.body ?? "") };
}

function desktopOffer(status: UpdateStatus | null): AppUpdate | null {
  if (!status?.latest || !isNewerVersion(status.latest, status.current)) return null;
  const { state, percent, error, installs } = status;
  if (state === "idle" || state === "checking" || state === "current") return null;
  return { kind: "desktop", state, percent, error, installs, ...offer(status.current, status.latest, status.notes ?? "") };
}

let desktopCheckedAt: number | undefined;

async function desktopStatusCheckedWhenDue() {
  const status = await desktopUpdate("status");
  if (!status || isDesktopPreview()) return status;
  if (status.state === "checking") return desktopUpdate("check");
  const settled = status.state === "idle" || status.state === "current" || (status.state === "error" && !status.latest);
  if (!settled || (desktopCheckedAt !== undefined && Date.now() - desktopCheckedAt < CHECK_EVERY_MS)) return status;
  desktopCheckedAt = Date.now();
  return desktopUpdate("check");
}

const unreachableDesktopAppShowsNoPill = () => null;

export async function availableUpdate(): Promise<AppUpdate | null> {
  if (!isDesktop()) return sourceUpdate();
  return desktopStatusCheckedWhenDue().then(desktopOffer, unreachableDesktopAppShowsNoPill);
}

export async function advanceDesktopUpdate() {
  let status = await desktopUpdate("status");
  if (status?.state === "error") status = await desktopUpdate("check");
  if (status?.state === "available" || status?.state === "downloaded") status = await desktopUpdate("install");
  return desktopOffer(status);
}
