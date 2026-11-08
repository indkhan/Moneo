import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { renderSVG } from "uqr";
import { z } from "zod";

// Optional access from the owner's phone and tablet: `tailscale serve` forwards their private
// Tailscale address to this Moneo, which keeps listening on 127.0.0.1 only. Tailscale remembers the
// setting, so Moneo stores nothing and nothing here runs unless Settings asks.
export type PhoneAccess =
  | { state: "off" | "not_installed" | "busy" }
  | { state: "disconnected"; forwarding: boolean }
  | { state: "signed_out" | "needs_approval"; link: string | null }
  | { state: "on"; url: string; qr: string };

/** Tailscale's own explanation of why it refused, worth showing to the owner. */
export class TailscaleError extends Error {}

const INSTALLED = ["C:\\Program Files\\Tailscale\\tailscale.exe", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const LOGIN_LINK = /https:\/\/login\.tailscale\.com\/\S+\s/;
const statusSchema = z.object({ BackendState: z.string(), AuthURL: z.string().optional(), Self: z.object({ DNSName: z.string() }).optional() });
const serveSchema = z.object({
  TCP: z.record(z.string(), z.unknown()).optional(),
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional() })).optional(),
});
type Result = { ok: boolean; stdout: string; output: string; missing?: boolean };

const cli = () => INSTALLED.find(path => existsSync(path)) ?? "tailscale";
const target = () => `http://127.0.0.1:${Number(process.env.PORT ?? 3000)}`;
const linkIn = (output: string) => output.match(LOGIN_LINK)?.[0].trim() ?? null;
const reason = (output: string) => new TailscaleError(output.trim().split("\n")[0] || "Tailscale did not respond");

/** Runs the CLI. Commands waiting on the owner print a login link and never exit, so `untilLink` stops there. */
function run(args: string[], untilLink = false) {
  return new Promise<Result>(resolve => {
    let stdout = "", output = "";
    const child = spawn(cli(), args, { windowsHide: true });
    const done = (result: Pick<Result, "ok" | "missing">) => { clearTimeout(timer); resolve({ ...result, stdout, output }); };
    const timer = setTimeout(() => { child.kill(); done({ ok: false }); }, 15_000);
    const read = (chunk: Buffer) => {
      output += chunk;
      if (untilLink && linkIn(output)) { child.kill(); done({ ok: false }); }
    };
    child.stdout.on("data", chunk => { stdout += chunk; read(chunk); });
    child.stderr.on("data", read);
    child.on("error", error => done({ ok: false, missing: (error as NodeJS.ErrnoException).code === "ENOENT" }));
    child.on("close", code => done({ ok: code === 0 }));
  });
}

const serveConfig = async () => serveSchema.parse(JSON.parse((await run(["serve", "status", "--json"])).stdout));

export async function phoneAccess(): Promise<PhoneAccess> {
  const status = await run(["status", "--json"]);
  if (status.missing) return { state: "not_installed" };
  // No JSON means the Tailscale service is stopped; opening the app starts it.
  if (!status.stdout.trim().startsWith("{")) return { state: "disconnected", forwarding: false };
  const tailscale = statusSchema.parse(JSON.parse(status.stdout));
  const host = tailscale.Self?.DNSName.replace(/\.$/, "");
  if (tailscale.BackendState === "Stopped") {
    const web = Object.values((await serveConfig()).Web ?? {});
    return { state: "disconnected", forwarding: web.some(site => site.Handlers?.["/"]?.Proxy === target()) };
  }
  if (tailscale.BackendState !== "Running" || !host) return { state: "signed_out", link: tailscale.AuthURL || null };
  const serve = await serveConfig();
  const handlers = serve.Web?.[`${host}:443`]?.Handlers ?? {};
  // Turning off clears the whole port, so a port shared with another path counts as someone else's.
  if (handlers["/"]?.Proxy === target() && Object.keys(handlers).length === 1) return { state: "on", url: `https://${host}`, qr: renderSVG(`https://${host}`) };
  return { state: Object.keys(handlers).length || serve.TCP?.["443"] ? "busy" : "off" };
}

/** Takes the next step toward on and says what, if anything, the owner has to do. */
export async function turnOnPhoneAccess(): Promise<PhoneAccess> {
  const current = await phoneAccess();
  if (current.state === "signed_out") return { state: "signed_out", link: current.link ?? linkIn((await run(["login"], true)).output) };
  if (current.state !== "off") return current;
  const serve = await run(["serve", "--bg", "--https=443", target()], true);
  if (serve.ok) return phoneAccess();
  const link = linkIn(serve.output);
  if (link) return { state: "needs_approval", link };
  throw reason(serve.output);
}

/** Removes Moneo's forward, never another app's. */
export async function turnOffPhoneAccess(): Promise<PhoneAccess> {
  if ((await phoneAccess()).state === "on") {
    const off = await run(["serve", "--https=443", "off"]);
    if (!off.ok) throw reason(off.output);
  }
  return phoneAccess();
}
