import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { backupApplication, installUpdate, prepareUpdate } from "./application-update.mjs";
import { checkRelease, latestRelease } from "./application-releases.mjs";

const previous = "a".repeat(40), sha = "b".repeat(40);
const target = { tag: "v1.2.3", sha, previous };
const roots: string[] = [];
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "moneo-update-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const github = () => vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ tag_name: "v1.2.3", name: "Moneo 1.2.3", body: "Changes", draft: false, prerelease: false })).mockResolvedValueOnce(Response.json({ sha }));

it("resolves a published release to a commit and caches daily checks without requiring a network when offline", async () => {
  const root = temporary(), fetcher = github();
  const first = await checkRelease(root, true, fetcher);
  expect(first.release?.sha).toBe(sha);
  const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  expect((await checkRelease(root, false, offline)).release).toEqual(first.release);
  expect(offline).not.toHaveBeenCalled();
  expect((await checkRelease(root, true, offline)).release).toEqual(first.release);
  expect((await checkRelease(root, false, offline)).error).toContain("connection");
});

it("handles an unpublished project and rejects a release tag that could become a command argument", async () => {
  expect(await latestRelease(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })))).toBeNull();
  const malicious = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tag_name: "--upload-pack=bad", name: null, body: null, draft: false, prerelease: false }));
  await expect(latestRelease(malicious)).rejects.toThrow();
});

it("refuses to touch a checkout with local changes before downloading or stopping anything", async () => {
  const root = temporary(); mkdirSync(join(root, ".git")); writeFileSync(join(root, ".env"), "SYNTHETIC=yes");
  const run = vi.fn(async (_command: string, args: string[]) => args[0] === "rev-parse" ? root.replaceAll("\\", "/") : " M README.md");
  const fetcher = github();
  await expect(prepareUpdate(root, target, run, fetcher)).rejects.toThrow("local code changes");
  expect(fetcher).not.toHaveBeenCalled();
});

it("backs up the database, uploaded files and local secrets without recursively copying backups", async () => {
  const root = temporary(); mkdirSync(join(root, ".data", "application"), { recursive: true });
  writeFileSync(join(root, ".env"), "SYNTHETIC=yes"); writeFileSync(join(root, ".data", "chatgpt.json"), "synthetic sealed token");
  const run = vi.fn(async (command: string, args: string[], options?: { stdio: (string | number)[] }) => {
    if (command === "git") return previous;
    const fd = options!.stdio[1] as number;
    writeFileSync(fd, args.includes("db") ? "synthetic database" : "synthetic storage");
    return "";
  });
  const path = await backupApplication(root, run);
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("SYNTHETIC=yes");
  expect(readFileSync(join(path, "database.dump"), "utf8")).toBe("synthetic database");
  expect(readFileSync(join(path, "storage.tar"), "utf8")).toBe("synthetic storage");
  expect(readFileSync(join(path, "data", "chatgpt.json"), "utf8")).toContain("synthetic");
});

function pipeline(root: string, fail: string | null = null) {
  const operations: string[] = [];
  const run = vi.fn(async (command: string, args: string[]) => {
    const operation = [command, ...args].join(" "); operations.push(operation);
    if (operation === fail) { fail = null; throw new Error("synthetic failure"); }
    return "";
  });
  const stop = vi.fn(async () => { operations.push("stop"); });
  const start = vi.fn(async () => { operations.push("start"); });
  const backup = vi.fn(async () => { operations.push("backup"); return join(root, "backup"); });
  const status = vi.fn();
  return { root, target, run, stop, start, backup, status, operations };
}

it("backs up before replacing code and migrates only after a successful build", async () => {
  const flow = pipeline(temporary());
  await installUpdate(flow);
  expect(flow.operations.indexOf("backup")).toBeLessThan(flow.operations.indexOf(`git checkout --detach ${sha}`));
  expect(flow.operations.indexOf("npm run build")).toBeLessThan(flow.operations.indexOf("npm run setup"));
  expect(flow.status).toHaveBeenLastCalledWith({ phase: "ready", message: "Moneo has been updated." });
});

it("never installs or migrates when the backup fails", async () => {
  const flow = pipeline(temporary());
  flow.backup.mockRejectedValue(new Error("disk full"));
  await installUpdate(flow);
  expect(flow.run).not.toHaveBeenCalled();
  expect(flow.start).toHaveBeenCalledOnce();
  expect(flow.status.mock.lastCall?.[0].phase).toBe("restored");
});

it("restores the previous app after a failed build without applying migrations", async () => {
  const flow = pipeline(temporary(), "npm run build");
  await installUpdate(flow);
  expect(flow.operations).toContain(`git checkout --detach ${previous}`);
  expect(flow.operations).not.toContain("npm run setup");
  expect(flow.status.mock.lastCall?.[0].phase).toBe("restored");
});

it("keeps recovery available and never starts older code after a migration failure", async () => {
  const flow = pipeline(temporary(), "npm run setup");
  await installUpdate(flow);
  expect(flow.operations).not.toContain(`git checkout --detach ${previous}`);
  expect(flow.start).not.toHaveBeenCalled();
  expect(flow.status.mock.lastCall?.[0]).toMatchObject({ phase: "failed", recovery: expect.stringContaining("backup") });
});
