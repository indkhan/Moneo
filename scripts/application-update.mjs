import { copyFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { applicationDirectory, writeJson } from "./application-state.mjs";
import { commitPattern, latestRelease, parseUpdateTarget } from "./application-releases.mjs";

const repository = "https://github.com/indkhan/Moneo.git";
/** All commands are argument arrays; a release can never supply a shell command or repository. */
export async function prepareUpdate(root, input, run, fetcher = fetch) {
  const target = parseUpdateTarget(input);
  if (!existsSync(join(root, ".git")) || !existsSync(join(root, ".env"))) throw new Error("Updates need an installed Git checkout with .env.");
  if (resolve(await run("git", ["rev-parse", "--show-toplevel"])).toLowerCase() !== resolve(root).toLowerCase()) throw new Error("Run updates from the Moneo repository root.");
  if (await run("git", ["status", "--porcelain", "--untracked-files=all"])) throw new Error("There are local code changes. Commit or move them before updating; nothing was overwritten.");
  const current = await run("git", ["rev-parse", "HEAD"]);
  if (!commitPattern.test(current)) throw new Error("Could not identify the installed commit.");
  const branch = await run("git", ["branch", "--show-current"]);
  if (branch && branch !== "main") throw new Error("Switch this installation to main before using the updater. Development branches are kept unchanged.");
  const remote = await run("git", ["remote", "get-url", "origin"]);
  if (![repository, repository.slice(0, -4), "git@github.com:indkhan/Moneo.git"].includes(remote)) throw new Error("Automatic updates require the official Moneo origin. Update this fork manually.");
  const latest = await latestRelease(fetcher);
  if (!latest || latest.tag !== target.tag || latest.sha !== target.sha) throw new Error("The release changed. Check for updates again before installing.");
  if (current === target.sha) throw new Error("This release is already installed.");
  await run("git", ["fetch", "--no-tags", repository, `refs/tags/${target.tag}`]);
  const fetched = await run("git", ["rev-parse", "FETCH_HEAD^{commit}"]);
  if (fetched !== target.sha) throw new Error("The downloaded release did not match GitHub. Nothing was installed.");
  try { await run("git", ["merge-base", "--is-ancestor", current, target.sha]); }
  catch { throw new Error("This installation has commits beyond the release. Update it manually to preserve them."); }
  const space = statfsSync(root, { bigint: true });
  if (space.bavail * space.bsize < 2n * 1024n ** 3n) throw new Error("Free at least 2 GB before updating, plus enough space for your data backup.");
  return { ...target, previous: current };
}

export async function backupApplication(root, run) {
  const backup = join(applicationDirectory(root), "backups", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  copyFileSync(join(root, ".env"), join(backup, ".env"));
  // Copy siblings separately: the application directory contains this backup itself.
  mkdirSync(join(backup, "data"));
  for (const name of readdirSync(join(root, ".data"))) {
    if (name !== "application") cpSync(join(root, ".data", name), join(backup, "data", name), { recursive: true });
  }
  mkdirSync(join(backup, "application"));
  for (const name of ["preferences.json", "startup.json", "installed.json"]) {
    const source = join(applicationDirectory(root), name);
    if (existsSync(source)) copyFileSync(source, join(backup, "application", name));
  }
  for (const [service, args, name] of [
    ["db", ["pg_dump", "-U", "postgres", "-d", "postgres", "--format=custom"], "database.dump"],
    ["storage", ["tar", "-C", "/var/lib/storage", "-cf", "-", "."], "storage.tar"],
  ]) {
    const file = openSync(join(backup, name), "wx", 0o600);
    try { await run("docker", ["compose", "exec", "-T", service, ...args], { stdio: ["ignore", file, "pipe"] }); }
    finally { closeSync(file); }
  }
  writeJson(join(backup, "manifest.json"), { createdAt: new Date().toISOString(), previous: await run("git", ["rev-parse", "HEAD"]) });
  return backup;
}

/** Stop on any backup error. Never run older code after a migration might have run. */
export async function installUpdate({ root, target, run, stop, start, status, backup = backupApplication }) {
  let saved = null;
  let changed = false;
  let migrated = false;
  try {
    status({ phase: "updating", message: "Stopping Moneo and backing up your data…" });
    await stop();
    saved = await backup(root, run);
    // Check again after the backup: no local edits made during preparation may be overwritten.
    if (await run("git", ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Local code changed during the update. Nothing was overwritten.");
    status({ phase: "updating", message: "Installing the release and its dependencies…" });
    await run("git", ["checkout", "--detach", target.sha]); changed = true;
    await run("npm", ["ci", "--no-audit", "--no-fund"]);
    // Build before migrations so most failures can return to the old version safely.
    status({ phase: "updating", message: "Building Moneo…" });
    await run("npm", ["run", "build"]);
    status({ phase: "updating", message: "Updating the local backend and database…" });
    migrated = true;
    await run("npm", ["run", "setup"]);
    status({ phase: "updating", message: "Restarting Moneo…" });
    await start();
    writeJson(join(applicationDirectory(root), "installed.json"), { tag: target.tag, sha: target.sha, backup: saved });
    status({ phase: "ready", message: "Moneo has been updated." });
  } catch (error) {
    if (!migrated) {
      try {
        if (changed) {
          status({ phase: "updating", message: "The update failed. Restoring the previous app…" });
          await run("git", ["checkout", "--detach", target.previous]);
          await run("npm", ["ci", "--no-audit", "--no-fund"]);
          await run("npm", ["run", "build"]);
        }
        await start();
        status({ phase: "restored", message: "The update failed. Your previous Moneo is running.", recovery: error.message });
        return;
      } catch { /* Keep the recovery page available if rebuilding the old app also failed. */ }
    }
    const recovery = saved
      ? `Backup: ${saved}\nThe database has not been automatically restored. Follow README → Update recovery. Fix the cause, then run npm ci, npm run setup, npm run build and npm start. Do not delete Docker volumes or regenerate .env.`
      : "The backup did not finish. Your data was not migrated. Check Docker and available disk space, then run npm start again.";
    status({ phase: "failed", message: `Update stopped: ${error.message}`, recovery });
  }
}
