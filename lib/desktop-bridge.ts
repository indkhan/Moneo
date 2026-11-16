import { NextResponse } from "next/server";
import { z } from "zod";

const bridge = () => process.env.MONEO_DESKTOP === "1" ? process.env.MONEO_DESKTOP_BRIDGE : undefined;
export const isDesktop = () => Boolean(bridge());

const CONTINUE_PAGE = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Return to Moneo</title>"
  + "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#0f1011}}</style>"
  + "<body><h1>Continue in Moneo</h1><p>The result is now open in the Moneo app. You can close this browser tab.</p></body></html>";

export async function connectionReturn(base: string | URL, path: string) {
  const url = bridge();
  if (url) {
    const handedToTheApp = await fetch(`${url}/return`, { method: "POST", headers: { "x-moneo-return": path }, signal: AbortSignal.timeout(10_000) }).then(response => response.ok, () => false);
    if (handedToTheApp) return new Response(CONTINUE_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
    });
  }
  return NextResponse.redirect(new URL(path, base), 303);
}

const updateStatus = z.object({
  current: z.string(),
  state: z.enum(["idle", "checking", "current", "available", "downloading", "installing", "error"]),
  latest: z.string().optional(),
  percent: z.number().optional(),
  error: z.string().optional(),
  installs: z.boolean(),
});
export type UpdateStatus = z.infer<typeof updateStatus>;

export async function desktopUpdate(action: "status" | "check" | "install"): Promise<UpdateStatus | null> {
  const url = bridge();
  if (!url) return null;
  const response = await fetch(`${url}/update${action === "status" ? "" : `/${action}`}`, {
    method: action === "status" ? "GET" : "POST",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`The desktop app answered ${response.status}`);
  return updateStatus.parse(await response.json());
}

const chosenFolder = z.object({ path: z.string().min(1).nullable() });

export async function desktopChooseFolder(): Promise<string | null> {
  const url = bridge();
  if (!url) return null;
  const response = await fetch(`${url}/choose-folder`, { method: "POST", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`The desktop app answered ${response.status}`);
  return chosenFolder.parse(await response.json()).path;
}
