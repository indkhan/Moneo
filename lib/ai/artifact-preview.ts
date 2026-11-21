import type { Browser, BrowserContext } from "playwright-core";
import { desktopRender, isDesktop } from "@/lib/desktop-bridge";
import { loopbackUrl } from "@/lib/env";

export type Shot = { label: string; path: string; width: number; height: number; full: boolean; root: string; theme: "light" | "dark" };
export type Seen = { label: string; png: Uint8Array; problems: string[] };
export type Session = { name: string; value: string }[];

export const sessionOf = (request: Request): Session => (request.headers.get("cookie") ?? "").split(";").flatMap(part => {
  const at = part.indexOf("=");
  const name = part.slice(0, at).trim();
  return at > 0 && name.startsWith("sb-") ? [{ name, value: part.slice(at + 1).trim() }] : [];
});

export const LAYOUT_PROBLEMS = String.raw`function (selector, theme) {
  var root = document.querySelector(selector);
  if (!root) return ["Nothing was drawn."];
  var problems = [];
  var page = selector === "body";
  var name = function (element) {
    var text = (element.textContent || "").trim().replace(/\s+/g, " ");
    return text ? '"' + text.slice(0, 40) + (text.length > 40 ? "…" : "") + '"' : "a <" + element.tagName.toLowerCase() + ">";
  };
  var shown = function (element) {
    var rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0.05;
  };
  var extent = function (element) {
    if (media(element)) return element.getBoundingClientRect();
    var range = document.createRange();
    range.selectNodeContents(element);
    var text = range.getBoundingClientRect(), own = element.getBoundingClientRect();
    return { left: Math.min(text.left, own.left), top: Math.min(text.top, own.top), right: Math.max(text.right, own.right), bottom: Math.max(text.bottom, own.bottom) };
  };
  var media = function (element) { var tag = element.tagName.toLowerCase(); return tag === "svg" || tag === "canvas"; };
  var leaves = Array.from(root.querySelectorAll("*")).filter(function (element) {
    if (element.closest("svg") && element.tagName.toLowerCase() !== "svg") return false;
    var ownText = Array.from(element.childNodes).some(function (node) { return node.nodeType === 3 && (node.textContent || "").trim(); });
    return (media(element) || ownText) && shown(element);
  }).slice(0, 400);
  if (!leaves.length) return ["Nothing visible was drawn."];
  var error = document.getElementById("moneo-page-error");
  if (error) problems.push("A script failed: " + error.textContent);
  var box = root.getBoundingClientRect();
  if (page) {
    var wide = document.documentElement.scrollWidth;
    if (wide > innerWidth + 1) problems.push("The page scrolls sideways at " + innerWidth + "px wide (it is " + wide + "px). Widest: "
      + leaves.filter(function (leaf) { return extent(leaf).right > innerWidth + 1; }).slice(0, 3).map(name).join(", "));
  } else {
    leaves.forEach(function (leaf) {
      var rect = extent(leaf);
      var edge = rect.bottom > box.bottom + 1 ? "bottom" : rect.right > box.right + 1 ? "right" : rect.left < box.left - 1 ? "left" : null;
      if (edge) problems.push(name(leaf) + " is cut off at the " + edge + " edge of the card");
    });
  }
  var overlay = function (element) { return getComputedStyle(element).position === "absolute"; };
  var overlaps = 0;
  for (var i = 0; i < leaves.length && overlaps < 6; i++) for (var j = i + 1; j < leaves.length && overlaps < 6; j++) {
    var a = leaves[i], b = leaves[j];
    if (a.contains(b) || b.contains(a) || (media(a) && overlay(b)) || (media(b) && overlay(a))) continue;
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    var width = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), height = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (width > 4 && height > 4 && width * height > 40) { problems.push(name(a) + " overlaps " + name(b)); overlaps++; }
  }
  leaves.forEach(function (leaf) {
    var size = parseFloat(getComputedStyle(leaf).fontSize);
    if (!media(leaf) && size < 10) problems.push(name(leaf) + " is " + size + "px text, too small to read");
  });
  if (page) {
    var channels = (getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) || []).map(Number);
    var light = (0.2126 * (channels[0] || 0) + 0.7152 * (channels[1] || 0) + 0.0722 * (channels[2] || 0)) / 255 > 0.5;
    var alpha = channels.length > 3 ? channels[3] : 1;
    if (alpha > 0.5 && light === (theme === "dark")) problems.push("The page ignores " + theme + " mode: its background stays " + (light ? "light" : "dark") + ". Take colours from the --moneo-* variables.");
  }
  return problems.filter(function (problem, index) { return problems.indexOf(problem) === index; }).slice(0, 20);
}`;

export const layoutScript = (selector: string, theme: string) => `(${LAYOUT_PROBLEMS})(${JSON.stringify(selector)}, ${JSON.stringify(theme)})`;

type Render = (shot: Shot, script: string) => Promise<{ png: Uint8Array; result: unknown }>;

const SETTLE_MS = 900;
const MAX_HEIGHT = 2400;
const IDLE_MS = 3 * 60_000;
const CHANNELS = [undefined, "msedge", "chrome"] as const;

const holder = globalThis as { moneoPreviewBrowser?: { context: Promise<BrowserContext | null>; idle?: ReturnType<typeof setTimeout> } };
const noBrowserInstalled = () => null;
const playwrightIsNotInstalled = () => null;

async function launch(): Promise<BrowserContext | null> {
  const playwright = await import(/* turbopackIgnore: true */ "playwright-core").catch(playwrightIsNotInstalled);
  if (!playwright) return null;
  let browser: Browser | null = null;
  for (const channel of CHANNELS) {
    browser = await playwright.chromium.launch({ channel, headless: true }).catch(noBrowserInstalled);
    if (browser) break;
  }
  return browser ? browser.newContext({ deviceScaleFactor: 1 }) : null;
}

function context() {
  const kept = holder.moneoPreviewBrowser ??= { context: launch() };
  if (kept.idle) clearTimeout(kept.idle);
  kept.idle = setTimeout(() => {
    holder.moneoPreviewBrowser = undefined;
    void kept.context.then(open => open?.browser()?.close());
  }, IDLE_MS);
  kept.idle.unref?.();
  return kept.context;
}

const playwrightRender = (open: BrowserContext, session: Session): Render => async (shot, script) => {
  await open.addCookies(session.map(({ name, value }) => ({ name, value, url: loopbackUrl() })));
  const page = await open.newPage();
  try {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.goto(`${loopbackUrl()}${shot.path}`, { waitUntil: "load", timeout: 20_000 });
    await page.waitForTimeout(SETTLE_MS);
    const result: unknown = await page.evaluate(script);
    const height = shot.full ? Math.min(MAX_HEIGHT, Math.max(shot.height, await page.evaluate(() => document.documentElement.scrollHeight))) : shot.height;
    const png = await page.screenshot({ fullPage: shot.full, clip: { x: 0, y: 0, width: shot.width, height } });
    return { png, result };
  } finally {
    await page.close();
  }
};

const desktopRenderer: Render = async (shot, script) => {
  const rendered = await desktopRender({ path: shot.path, width: shot.width, height: shot.height, full: shot.full, script });
  if (!rendered) throw new Error("The desktop app is not reachable");
  return rendered;
};

async function renderer(session: Session): Promise<Render | null> {
  if (isDesktop()) return desktopRenderer;
  const open = await context();
  return open ? playwrightRender(open, session) : null;
}

const problemList = (result: unknown) => Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : [];

export async function lookAt(shots: Shot[], session: Session): Promise<Seen[] | null> {
  const render = await renderer(session);
  if (!render) return null;
  const seen: Seen[] = [];
  for (const shot of shots) {
    const { png, result } = await render(shot, layoutScript(shot.root, shot.theme));
    seen.push({ label: shot.label, png, problems: problemList(result) });
  }
  return seen;
}
