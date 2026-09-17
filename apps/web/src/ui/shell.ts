// E01-S06 minimal HTML shell: zero client JavaScript, native keyboard
// semantics (links/buttons/forms), strict escaping of every interpolated
// value. No <script> tag may ever appear in output (suite-grepped).

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const STYLE = [
  "body{font-family:system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem;line-height:1.5}",
  "a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #005fcc;outline-offset:2px}",
  ".skip{position:absolute;left:-9999px}",
  ".skip:focus{position:static}",
  "header nav ul{list-style:none;display:flex;gap:1rem;padding:0}",
  ".alert{border:2px solid #b00020;padding:1rem;margin:1rem 0}",
  ".notice{border:2px solid #006400;padding:1rem;margin:1rem 0}",
  "table{border-collapse:collapse;width:100%}",
  "th,td{border:1px solid #666;padding:.4rem;text-align:left}",
  "form.inline{display:inline}",
  "footer{margin-top:2rem;color:#555;font-size:.85rem}",
].join("");

export function page(opts: { title: string; requestId: string; authed: boolean; notice?: string; content: string }): string {
  const notice = opts.notice ? `<div class="notice" role="status"><p>${escapeHtml(opts.notice)}</p></div>` : "";
  const nav = opts.authed
    ? `<ul><li><a href="/">Workspaces</a></li><li><form class="inline" method="post" action="/auth/logout"><button type="submit">Log out</button></form></li></ul>`
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
