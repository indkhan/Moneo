// E01-S06 minimal HTML shell: zero client JavaScript, native keyboard
// semantics (links/buttons/forms), strict escaping of every interpolated
// value. No <script> tag may ever appear in output (suite-grepped).

export function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const STYLE = [
  "body{font-family:system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem;line-height:1.5}",
  "a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #005fcc;outline-offset:2px}",
  ".skip{position:absolute;left:-9999px}",
  ".skip:focus{position:static}",
  "header nav ul{list-style:none;display:flex;gap:1rem;padding:0}",
  ".alert{border:2px solid #b00020;padding:1rem;margin:1rem 0}",
  ".notice{border:2px solid #006400;padding:1rem;margin:1rem 0}",
  "table{border-collapse:collapse;width:100%}",
  "th,td{border:1px solid #666;padding:.4rem;text-align:left}",
  "form.inline{display:inline}",
  "footer{margin-top:2rem;color:#555;font-size:.85rem}",
  // Chat UI
  ".chat-header{border-bottom:1px solid #ccc;padding-bottom:1rem;margin-bottom:1rem}",
  ".chat-header .meta{color:#555;font-size:.9rem;margin:.5rem 0 0}",
  ".chat-main{display:flex;gap:1rem}",
  ".turns{flex:1;min-width:0}",
  ".activity-panel{width:220px;flex-shrink:0;border-left:1px solid #eee;padding-left:1rem;font-size:.85rem}",
  ".activity-list{list-style:none;padding:0;margin:0}",
  ".activity-list li{padding:.3rem 0;border-bottom:1px solid #f0f0f0}",
  ".turn{margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:1px solid #eee}",
  ".turn.assistant{border-left:3px solid #005fcc;padding-left:.8rem}",
  ".turn header{display:flex;gap:.5rem;align-items:center;margin-bottom:.3rem;font-size:.85rem;color:#555}",
  ".turn-header time{font-size:.75rem;color:#888}",
  ".turn-body{white-space:pre-wrap;word-wrap:break-word}",
  ".turn-body pre{background:#f5f5f5;padding:.5rem;overflow:auto;border-radius:4px}",
  ".turn-body code{background:#f0f0f0;padding:.1rem .3rem;border-radius:3px;font-family:monospace}",
  ".turn-body blockquote{border-left:3px solid #ccc;margin:1rem 0;padding-left:1rem;color:#555}",
  ".badge{display:inline-block;padding:.1rem .4rem;border-radius:3px;font-size:.7rem;font-weight:600;text-transform:uppercase}",
  ".badge.queued{background:#fff3cd;color:#856404}",
  ".badge.running{background:#cce5ff;color:#004085}",
  ".badge.completed{background:#d4edda;color:#155724}",
  ".badge.interrupted{background:#f8d7da;color:#721c24}",
  ".badge.failed{background:#f8d7da;color:#721c24}",
  ".badge.cancelled{background:#e2e3e5;color:#383d41}",
  ".context-bar{margin-bottom:.5rem;padding:.5rem;background:#f8f9fa;border-radius:4px;display:flex;flex-wrap:wrap;gap:.3rem}",
  ".context-chip{display:inline-flex;align-items:center;gap:.2rem;padding:.2rem .5rem;background:#e9ecef;border-radius:20px;font-size:.8rem}",
  ".context-chip button{background:none;border:none;padding:0;margin-left:.2rem;cursor:pointer;font-size:.8rem;line-height:1;color:#495057}",
  ".context-chip button:hover{color:#dc3545}",
  ".send-area{margin-top:1.5rem;padding-top:1rem;border-top:1px solid #eee}",
  ".send-area textarea{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:4px;font-family:inherit;font-size:1rem;resize:vertical;min-height:80px}",
  ".send-area .form-actions{margin-top:.5rem;display:flex;gap:.5rem}",
  ".send-area button{padding:.5rem 1rem;background:#005fcc;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:1rem}",
  ".send-area button:hover{background:#0047a0}",
  ".send-area button:disabled{opacity:.6;cursor:not-allowed}",
  ".chat-main{display:flex;gap:1rem;align-items:flex-start}",
  "@media (max-width: 700px) { .chat-main { flex-direction: column; } .activity-panel { width: 100%; border-left: none; border-top: 1px solid #eee; padding-top: 1rem; padding-left: 0; } }",
  // E07-S04 workspace navigation + job/notices surfaces. Native links only
  // (zero client JavaScript): the Jump entry carries accesskey="k" so the
  // exact-route palette is keyboard-reachable without script; Escape clears
  // the palette field natively and Back returns focus. No motion is used, so
  // prefers-reduced-motion is a no-op by construction (declared honestly).
  ".wsnav{border-bottom:1px solid #ccc;margin-bottom:1rem;padding-bottom:.5rem}",
  ".wsnav ul{list-style:none;display:flex;flex-wrap:wrap;gap:.4rem 1rem;padding:0;margin:.5rem 0}",
  ".wsnav a{display:inline-block;min-height:44px;line-height:44px}",
  "@media (prefers-reduced-motion: reduce) { *{transition:none;animation:none} }",
].join("");

/**
 * E07-S04 primary destinations: Home / Money / Plan / AI (product §3),
 * plus Jobs, Notices and the exact-route palette entry ("Jump to…",
 * accesskey k, with a visible fallback link list on the /go page).
 * Rendered inside page content by workspace pages (Home/chat/import/
 * artifact/jobs/notices/go); every href is workspace-scoped and escaped.
 */
export function workspaceNav(workspaceId: string): string {
  const w = escapeHtml(workspaceId);
  return `<nav class="wsnav" aria-label="Workspace"><ul><li><a href="/w/${w}/home">Home</a></li><li><a href="/w/${w}/transactions">Money</a></li><li><a href="/w/${w}/planning">Plan</a></li><li><a href="/w/${w}/chat">AI</a></li><li><a href="/w/${w}/jobs">Jobs</a></li><li><a href="/w/${w}/notices">Notices</a></li><li><a href="/w/${w}/privacy">Privacy</a></li><li><a href="/w/${w}/go" accesskey="k" title="Jump to… (access key K)">Jump to…</a></li></ul></nav>`;
}

export function page(opts: { title: string; requestId: string; authed: boolean; notice?: string; content: string }): string {
  const notice = opts.notice ? `<div class="notice" role="status"><p>${escapeHtml(opts.notice)}</p></div>` : "";
  const nav = opts.authed
    ? `<ul><li><a href="/">Workspaces</a></li><li><form class="inline" method="post" action="/logout"><button type="submit">Log out</button></form></li></ul>`
    : `<ul><li><a href="/auth/login">Log in</a></li></ul>`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)} — Moneo</title><style>${STYLE}</style></head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header><nav aria-label="Primary">${nav}</nav></header>
<main id="main"><h1>${escapeHtml(opts.title)}</h1>${notice}${opts.content}</main>
<footer><p>Request ${escapeHtml(opts.requestId)}</p></footer>
</body>
</html>
`;
}

export function errorPage(opts: { status: number; heading: string; message: string; back: string; requestId: string; authed: boolean }): string {
  return page({
    title: opts.heading,
    requestId: opts.requestId,
    authed: opts.authed,
    content: `<div class="alert" role="alert"><h2>${escapeHtml(opts.heading)}</h2><p>${escapeHtml(opts.message)}</p><p><a href="${escapeHtml(opts.back)}">Back</a></p></div>`,
  });
}
