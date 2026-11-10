import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { localApplicationRequest, readJson, setStartup, startupEnabled, startupEntry, writeJson } from "./application-state.mjs";

vi.mock("node:os", async original => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(homedir).mockReset(); });

it("accepts only loopback application controls, including when a proxy supplies the host", () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000"]) expect(localApplicationRequest(new Headers({ host }))).toBe(true);
  const denied: Record<string, string>[] = [
    { host: "laptop.example.ts.net" },
    { host: "localhost:3000", "x-forwarded-host": "laptop.example.ts.net" },
    { host: "localhost.attacker.test" },
    { host: "127.0.0.1:3000", "tailscale-funnel-request": "true" },
  ];
  for (const headers of denied) expect(localApplicationRequest(new Headers(headers))).toBe(false);
});

it("registers and removes only this installation's startup file", () => {
  const home = mkdtempSync(join(tmpdir(), "moneo-startup-"));
  vi.mocked(homedir).mockReturnValue(home);
  vi.stubEnv("APPDATA", home); vi.stubEnv("XDG_CONFIG_HOME", home);
  try {
    const first = join(home, "Moneo one"), second = join(home, "Moneo two");
    setStartup(first, true); setStartup(second, true);
    expect(startupEnabled(first)).toBe(true);
    expect(readFileSync(startupEntry(first).path, "utf8")).toContain("application-launcher.mjs");
    setStartup(first, false);
    expect(startupEnabled(first)).toBe(false);
    expect(startupEnabled(second)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("escapes paths without allowing startup command injection on any platform", () => {
  const root = join(tmpdir(), 'Moneo & $test');
  const mac = startupEntry(root, "darwin", tmpdir(), {}, "/usr/local/bin/node");
  expect(mac.content).toContain("&amp;");
  expect(mac.content).toContain("<string>/usr/local/bin/node</string>");
  const linux = startupEntry(root, "linux", tmpdir(), {}, "/usr/bin/node");
  expect(linux.content).toContain('Exec="/usr/bin/node"');
  expect(linux.content).toContain("\\\\$test");
  expect(() => startupEntry(join(tmpdir(), "Moneo%unsafe"), "win32", tmpdir(), { APPDATA: tmpdir() })).toThrow("percent");
  expect(() => startupEntry("Moneo\nExec=bad", "linux")).toThrow("line breaks");
});

it("keeps local application state across atomic replacements", () => {
  const root = mkdtempSync(join(tmpdir(), "moneo-state-"));
  try {
    const path = join(root, "nested", "state.json");
    expect(readJson(path, { enabled: false })).toEqual({ enabled: false });
    writeJson(path, { enabled: true }); writeJson(path, { enabled: false });
    expect(readJson(path)).toEqual({ enabled: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
