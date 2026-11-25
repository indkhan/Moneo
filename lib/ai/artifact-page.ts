export const ARTIFACT_LIBRARIES = { "echarts.min.js": "ECharts 6" } as const;
const CDN_ECHARTS = /https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@[\w.-]+\/dist\/echarts(?:\.min)?\.js/g;

const pageCsp = (origin: string) => `default-src 'none'; script-src 'unsafe-inline' ${origin}/artifact-lib/; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'`;

export const artifactFrameCsp = (origin: string) => `${pageCsp(origin)}; frame-src 'none'; sandbox allow-scripts; frame-ancestors 'self'`;

export type ArtifactTheme = "light" | "dark";

const PALETTE: Record<string, [light: string, dark: string]> = { bg: ["#f4f3ee", "#0f1011"], card: ["#fff", "#16171a"], fg: ["#141413", "#eeece6"], muted: ["#5c5d58", "#a3a39e"],
  border: ["#e2e0d8", "#24262a"], accent: ["#4a6400", "#cbf26b"], positive: ["#3f6b00", "#cbf26b"], negative: ["#b42318", "#ff7a6b"],
  "chart-1": ["#4a6400", "#cbf26b"], "chart-2": ["#6d5bd0", "#a99bff"], "chart-3": ["#0e7490", "#67d4e8"], "chart-4": ["#b45309", "#fbbf6b"], "chart-5": ["#9d174d", "#f9a8c9"] };
const palette = (side: 0 | 1) => Object.entries(PALETTE).map(([name, colours]) => `--moneo-${name}:${colours[side]}`).join(";");
const tokens = (theme?: ArtifactTheme) => `:root{--moneo-font:ui-sans-serif,system-ui,sans-serif;--moneo-mono:ui-monospace,Consolas,monospace;${palette(theme === "dark" ? 1 : 0)}}`
  + (theme ? "" : `@media (prefers-color-scheme:dark){:root{${palette(1)}}}`);
const KIT = "*{box-sizing:border-box}body{margin:0;background:var(--moneo-bg);color:var(--moneo-fg);font:15px/1.5 var(--moneo-font)}"
  + ".m-page{max-width:1100px;margin:0 auto;padding:32px 24px;display:grid;gap:20px}.m-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}"
  + ".m-card{background:var(--moneo-card);border:1px solid var(--moneo-border);border-radius:16px;padding:20px}.m-eyebrow{font:500 11px/1.4 var(--moneo-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--moneo-muted)}"
  + ".m-title{font-size:28px;font-weight:600;letter-spacing:-.02em;margin:0}.m-stat{font-size:40px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.1}"
  + ".m-muted{color:var(--moneo-muted)}.m-pos{color:var(--moneo-positive)}.m-neg{color:var(--moneo-negative)}.m-mono{font-family:var(--moneo-mono)}"
  + ".m-row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--moneo-border)}.m-row:last-child{border-bottom:0}"
  + ".m-pill{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--moneo-border);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}.m-pill[aria-pressed=true]{background:var(--moneo-fg);color:var(--moneo-bg)}"
  + "input[type=range]{accent-color:var(--moneo-accent);width:100%}";

export const artifactDraftCsp = (origin: string) => `${pageCsp(origin)}; sandbox allow-scripts; frame-ancestors 'none'`;

export function artifactPage(html: string, data: Record<string, unknown>, { theme, origin }: { theme?: ArtifactTheme; origin: string }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const scheme = theme ?? "light dark";
  const head = `<meta http-equiv="Content-Security-Policy" content="${pageCsp(origin)}"><script>window.MONEO_DATA=${json};`
    + `addEventListener("click",e=>{if(e.target instanceof Element&&e.target.closest("a[href]"))e.preventDefault()},true);`
    + `addEventListener("error",e=>{if(document.getElementById("moneo-page-error"))return;const show=()=>{const n=document.createElement("p");n.id="moneo-page-error";n.setAttribute("role","alert");`
    + `n.style.cssText="margin:16px;padding:12px 16px;border:1px solid var(--moneo-negative);border-radius:12px;color:var(--moneo-negative);font:14px/1.5 var(--moneo-font)";`
    + `n.textContent="Part of this page failed to run, so some values are missing. Ask Moneo in the chat to fix it. ("+(e.message||"script error")+")";document.body.prepend(n)};`
    + `document.body?show():addEventListener("DOMContentLoaded",show)});</script>`
    + `<style>${tokens(theme)}${KIT}:root{color-scheme:${scheme}}</style>`;
  return (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + head) : head + html).replace(CDN_ECHARTS, `${origin}/artifact-lib/echarts.min.js`);
}

export function artifactDocument(html: string, data: Record<string, unknown>, options: { theme?: ArtifactTheme; origin: string }) {
  const scheme = options.theme ?? "light dark";
  const page = artifactPage(html, data, options);
  const srcdoc = page.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${scheme}}html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block;background:transparent}</style></head>`
    + `<body><iframe title="Artifact page" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe></body></html>`;
}
