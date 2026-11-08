import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { phoneAccess, turnOffPhoneAccess, turnOnPhoneAccess } from "./phone-access";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: () => false }));

const HOST = "pc.example.ts.net";
const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${HOST}.` } });
const serving = (proxy: string) => JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });

type Answer = { out?: string; code?: number; missing?: boolean };
let answers: Record<string, Answer>;
const calls = () => vi.mocked(spawn).mock.calls.map(([, args]) => (args as string[]).join(" "));

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  answers = {};
  vi.mocked(spawn).mockImplementation(((_file: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    const answer = answers[args.join(" ")] ?? {};
    queueMicrotask(() => {
      if (answer.missing) return child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
      if (answer.out) child.stdout.emit("data", Buffer.from(answer.out));
      child.emit("close", answer.code ?? 0);
    });
    return child;
  }) as never);
});

it("reports each stage from what Tailscale says", async () => {
  answers["status --json"] = { missing: true };
  expect(await phoneAccess()).toEqual({ state: "not_installed" });
  answers["status --json"] = { out: "failed to connect to local tailscaled", code: 1 };
  expect(await phoneAccess()).toEqual({ state: "signed_out", link: null });
  answers["status --json"] = { out: JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "", Self: { DNSName: "" } }) };
  expect(await phoneAccess()).toEqual({ state: "signed_out", link: null });
  answers["status --json"] = { out: running };
  answers["serve status --json"] = { out: "{}" };
  expect(await phoneAccess()).toEqual({ state: "off" });
});

it("shows the address and scan code only for Moneo's own forward", async () => {
  answers["status --json"] = { out: running };
  answers["serve status --json"] = { out: serving("http://127.0.0.1:3000") };
  expect(await phoneAccess()).toMatchObject({ state: "on", url: `https://${HOST}`, qr: expect.stringContaining("<svg") });
  answers["serve status --json"] = { out: serving("http://127.0.0.1:9999") };
  expect(await phoneAccess()).toEqual({ state: "busy" });
});

it("turns on through Tailscale's own forward to this computer", async () => {
  answers["status --json"] = { out: running };
  answers["serve status --json"] = { out: "{}" };
  await turnOnPhoneAccess();
  expect(calls()).toContain("serve --bg --https=443 http://127.0.0.1:3000");
});

it("gives the owner the link when Tailscale needs them to approve HTTPS or sign in", async () => {
  answers["status --json"] = { out: running };
  answers["serve status --json"] = { out: "{}" };
  answers["serve --bg --https=443 http://127.0.0.1:3000"] = { out: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc\n" };
  expect(await turnOnPhoneAccess()).toEqual({ state: "needs_approval", link: "https://login.tailscale.com/f/serve?node=abc" });
  answers["status --json"] = { out: JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "" }) };
  answers.login = { out: "To authenticate, visit:\n\n\thttps://login.tailscale.com/a/2\n" };
  expect(await turnOnPhoneAccess()).toEqual({ state: "signed_out", link: "https://login.tailscale.com/a/2" });
});

it("never replaces another app's forward", async () => {
  answers["status --json"] = { out: running };
  answers["serve status --json"] = { out: serving("http://127.0.0.1:9999") };
  expect(await turnOnPhoneAccess()).toEqual({ state: "busy" });
  await turnOffPhoneAccess();
  expect(calls().filter(call => !call.includes("status"))).toEqual([]);
});

it("turns off Moneo's own forward", async () => {
  answers["status --json"] = { out: running };
  answers["serve status --json"] = { out: serving("http://127.0.0.1:3000") };
  await turnOffPhoneAccess();
  expect(calls()).toContain("serve --https=443 off");
});
