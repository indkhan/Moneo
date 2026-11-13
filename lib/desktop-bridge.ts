import { NextResponse } from "next/server";
import { z } from "zod";

// Moneo Desktop passes the server a private loopback address for what only the app can do
// (desktop/src/bridge.ts). A source checkout has none, and these fall back or report unavailable.
const bridge = () => process.env.MONEO_DESKTOP === "1" ? process.env.MONEO_DESKTOP_BRIDGE : undefined;
export const isDesktop = () => Boolean(bridge());

const CONTINUE_PAGE = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Return to Moneo</title>"
  + "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#0f1011}}</style>"
  + "<body><h1>Continue in Moneo</h1><p>The result is now open in the Moneo app. You can close this browser tab.</p></body></html>";

/**
 * Where a sign-in that ran in the system browser (bank, Scalable, ChatGPT) ends. In Moneo Desktop the
 * result opens in the app window, and the browser tab says so; otherwise, or if the window cannot
 * open it, the browser is redirected as before.
 */
export async function connectionReturn(base: string | URL, path: string) {
  const url = bridge();
  if (url) {
    try {
      const response = await fetch(`${url}/return`, { method: "POST", headers: { "x-moneo-return": path }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return new Response(CONTINUE_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
      });
    } catch { /* fall back to showing the result in the browser */ }
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

/** Moneo Desktop's update status, or asks it to check for or install an update. */
export async function desktopUpdate(action: "status" | "check" | "install"): Promise<UpdateStatus | null> {
  const url = bridge();
  if (!url) return null;
  const response = await fetch(`${url}/update${action === "status" ? "" : `/${action}`}`, {
    method: action === "status" ? "GET" : "POST",
    // A check waits for GitHub; installing answers at once and the page follows the download.
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`The desktop app answered ${response.status}`);
  return updateStatus.parse(await response.json());
}
