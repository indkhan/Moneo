import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { renderSVG } from "uqr";
import { z } from "zod";

// Optional access from the owner's phone and tablet: `tailscale serve` forwards their private
// Tailscale address to this Moneo, which keeps listening on 127.0.0.1 only. Tailscale remembers the
// setting, so Moneo stores nothing and nothing here runs unless Settings asks.
export type PhoneAccess =
  | { state: "off" | "not_installed" | "busy" }
  | { state: "signed_out" | "needs_approval"; link: string | null }
  | { state: "on"; url: string; qr: string };

const INSTALLED = ["C:\\Program Files\\Tailscale\\tailscale.exe", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const LOGIN_LINK = /https:\/\/login\.tailscale\.com\/\S+/;
const statusSchema = z.object({ BackendState: z.string(), AuthURL: z.string().optional(), Self: z.object({ DNSName: z.string() }).optional() });
const serveSchema = z.object({
  TCP: z.record(z.string(), z.unknown()).optional(),
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional() })).optional(),
});
type Result = { ok: boolean; output: string; missing?: boolean };

const cli = () => INSTALLED.find(path => existsSync(path)) ?? "tailscale";
const target = () => `http://127.0.0.1:${Number(process.env.PORT ?? 3000)}`;
const linkIn = (output: string) => output.match(LOGIN_LINK)?.[0] ?? null;

/** Runs the CLI. Commands waiting on the owner print a login link and never exit, so they stop there. */
function run(args: string[]) {
  return new Promise<Result>(resolve => {
    let output = "";
    const child = spawn(cli(), args, { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output }); }, 15_000);
    const done = (result: Result) => { clearTimeout(timer); resolve(result); };
    const read = (chunk: Buffer) => {
      output += chunk;
      if (linkIn(output)) { child.kill(); done({ ok: false, output }); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", error => done({ ok: false, output, missing: (error as NodeJS.ErrnoException).code === "ENOENT" }));
    child.on("close", code => done({ ok: code === 0, output }));
  });
}

export async function phoneAccess(): Promise<PhoneAccess> {
  const status = await run(["status", "--json"]);
  if (status.missing) return { state: "not_installed" };
  // No JSON means the Tailscale service is stopped; opening the app starts it.
  if (!status.output.trim().startsWith("{")) return { state: "signed_out", link: null };
  const tailscale = statusSchema.parse(JSON.parse(status.output));
  const host = tailscale.Self?.DNSName.replace(/\.$/, "");
  if (tailscale.BackendState !== "Running" || !host) return { state: "signed_out", link: tailscale.AuthURL || null };
  const serve = serveSchema.parse(JSON.parse((await run(["serve", "status", "--json"])).output));
  const proxy = serve.Web?.[`${host}:443`]?.Handlers?.["/"]?.Proxy;
  if (proxy === target()) return { state: "on", url: `https://${host}`, qr: renderSVG(`https://${host}`) };
  return { state: proxy || serve.TCP?.["443"] ? "busy" : "off" };
}

/** Takes the next step toward on and says what, if anything, the owner has to do. */
export async function turnOnPhoneAccess(): Promise<PhoneAccess> {
  const current = await phoneAccess();
  if (current.state === "signed_out") return { state: "signed_out", link: current.link ?? linkIn((await run(["login"])).output) };
  if (current.state !== "off") return current;
  const serve = await run(["serve", "--bg", "--https=443", target()]);
  if (serve.ok) return phoneAccess();
  const link = linkIn(serve.output);
  if (link) return { state: "needs_approval", link };
  throw new Error(serve.output.trim() || "Tailscale did not respond");
}

/** Removes only Moneo's forward, never another app's. */
export async function turnOffPhoneAccess(): Promise<PhoneAccess> {
  if ((await phoneAccess()).state === "on") {
    const off = await run(["serve", "--https=443", "off"]);
    if (!off.ok) throw new Error(off.output.trim() || "Tailscale did not respond");
  }
  return phoneAccess();
}
