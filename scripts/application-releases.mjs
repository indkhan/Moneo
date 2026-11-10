import { join } from "node:path";
import { applicationDirectory, readJson, writeJson } from "./application-state.mjs";

const api = "https://api.github.com/repos/indkhan/Moneo";
export const releaseTagPattern = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
export const commitPattern = /^[a-f0-9]{40}$/;
// Recovery must still load when npm ci was interrupted: use no npm dependencies here.
export function parseUpdateTarget(input) {
  if (!input || typeof input.tag !== "string" || !releaseTagPattern.test(input.tag) || typeof input.sha !== "string" || !commitPattern.test(input.sha)) throw new Error("Invalid release tag or commit.");
  return { tag: input.tag, sha: input.sha };
}

export async function latestRelease(fetcher = fetch) {
  const get = async path => fetcher(`${api}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "Moneo-local-updater" }, signal: AbortSignal.timeout(15_000) });
  const response = await get("/releases/latest");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("GitHub could not check releases. Try again later.");
  const release = await response.json();
  if (!release || typeof release.tag_name !== "string" || !releaseTagPattern.test(release.tag_name) || release.draft !== false || release.prerelease !== false || (release.name !== null && typeof release.name !== "string") || (release.body !== null && typeof release.body !== "string")) throw new Error("GitHub returned an invalid release.");
  const commit = await get(`/commits/${encodeURIComponent(release.tag_name)}`);
  if (!commit.ok) throw new Error("The release commit could not be verified.");
  const { sha } = parseUpdateTarget({ tag: release.tag_name, sha: (await commit.json()).sha });
  return { tag: release.tag_name, sha, name: release.name || release.tag_name, notes: release.body || "", url: `https://github.com/indkhan/Moneo/releases/tag/${encodeURIComponent(release.tag_name)}` };
}

export async function checkRelease(root, force = false, fetcher = fetch) {
  const path = join(applicationDirectory(root), "release.json");
  const cached = readJson(path);
  if (!force && cached && Date.now() - cached.checkedAt < 86_400_000) return cached;
  try {
    const result = { checkedAt: Date.now(), release: await latestRelease(fetcher), error: null };
    writeJson(path, result); return result;
  } catch {
    const result = { checkedAt: Date.now(), release: cached?.release ?? null, error: "Could not check GitHub. Check your connection and try again." };
    writeJson(path, result); return result;
  }
}
