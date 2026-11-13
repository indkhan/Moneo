import { NextResponse } from "next/server";

const CONTINUE_PAGE = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Return to Moneo</title>"
  + "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#0f1011}}</style>"
  + "<body><h1>Continue in Moneo</h1><p>The result is now open in the Moneo app. You can close this browser tab.</p></body></html>";

/**
 * Where a sign-in that ran in the system browser (bank, Scalable, ChatGPT) ends. In Moneo Desktop the
 * result opens in the app window through its private return address, and the browser tab says so;
 * otherwise, or if the window cannot open it, the browser is redirected as before.
 */
export async function connectionReturn(base: string | URL, path: string) {
  const bridge = process.env.MONEO_DESKTOP_AUTH_RETURN;
  if (process.env.MONEO_DESKTOP === "1" && bridge) {
    try {
      const response = await fetch(bridge, { method: "POST", headers: { "x-moneo-return": path }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return new Response(CONTINUE_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
      });
    } catch { /* fall back to showing the result in the browser */ }
  }
  return NextResponse.redirect(new URL(path, base), 303);
}
