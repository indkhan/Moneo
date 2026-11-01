import postcss from "postcss";
import { z } from "zod";
import type { CardNode } from "./sandbox";

/**
 * Checks a card's element tree before anything renders it. The card's code ran in the sandbox, but its
 * output is still untrusted: only known HTML/SVG elements and attributes pass, no URL can reach outside the
 * card, ids are namespaced, CSS is scoped to the card, and Kit props must match their schema exactly.
 */

const HTML = ["div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "b", "i", "small", "br", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "section", "header", "footer", "article", "figure", "figcaption", "time", "abbr",
  "sup", "sub", "mark", "s", "u", "blockquote", "dl", "dt", "dd", "progress", "meter"];
const SVG = ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "linearGradient",
  "radialGradient", "stop", "clipPath", "title", "filter", "feGaussianBlur", "feDropShadow", "feOffset", "feBlend", "feColorMatrix",
  "feMerge", "feMergeNode", "feFlood", "feComposite"];
const ELEMENTS = new Set([...HTML, ...SVG]);
const ATTRIBUTES = new Set(["className", "style", "title", "role", "id", "colSpan", "rowSpan", "dateTime", "value", "max", "min", "low", "high", "optimum",
  "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "d", "points", "pathLength",
  "fill", "fillOpacity", "fillRule", "clipRule", "stroke", "strokeWidth", "strokeOpacity", "strokeLinecap", "strokeLinejoin", "strokeDasharray",
  "strokeDashoffset", "strokeMiterlimit", "opacity", "transform", "transformOrigin", "offset", "stopColor", "stopOpacity", "gradientTransform", "gradientUnits",
  "spreadMethod", "textAnchor", "dominantBaseline", "alignmentBaseline", "fontSize", "fontWeight", "fontFamily", "letterSpacing", "dx", "dy",
  "preserveAspectRatio", "clipPath", "clipPathUnits", "filter", "filterUnits", "stdDeviation", "in", "in2", "result", "mode", "values", "type",
  "floodColor", "floodOpacity", "operator", "k1", "k2", "k3", "k4", "vectorEffect", "overflow", "display", "visibility"]);
// Only url(#local-id) may appear in a value; anything else that can load or run something is refused.
const LOCAL_URL = /^url\(#([A-Za-z][\w-]{0,60})\)$/;
// No element here takes a link (no href, src or <use>), so CSS functions that load something are the only ways out.
// A backslash is refused outright: CSS escapes (u\72l(...)) would spell those functions past any pattern.
const UNSAFE_VALUE = /\\|\b(?:-webkit-)?(?:url|src|image|image-set|cross-fade|element|expression)\s*\(|@import/i;
const ID = /^[A-Za-z][\w-]{0,60}$/;

export type TreeContext = { scope: string };
const value = z.union([z.string().max(20000), z.number().finite()]);
const style = z.record(z.string().regex(/^(--)?[a-zA-Z][a-zA-Z0-9-]{0,60}$/), value).optional();
const look = { className: z.string().max(2000).optional(), style };

const ROUTES = ["transactions", "budgets", "recurring", "goals", "accounts", "wealth", "plan", "forecast", "artifacts"] as const;
export const linkTarget = z.object({
  page: z.enum(ROUTES),
  account: z.uuid().optional(), category: z.union([z.uuid(), z.literal("none")]).optional(), merchant: z.union([z.uuid(), z.literal("none")]).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), q: z.string().max(100).optional(), direction: z.enum(["income", "outflow"]).optional(),
}).strict();
const color = z.string().regex(/^(var\(--[a-z0-9-]{1,40}\)|#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([^;{}<>]{1,120}\)|[a-z]{3,20})$/);

/** The props each Kit component accepts; unknown props are refused, so nothing unexpected reaches our components. */
const KIT = {
  Money: z.object({ minor: z.union([z.string().regex(/^-?\d{1,30}$/), z.number().int()]), currency: z.string().regex(/^[A-Z]{3}$/), signed: z.boolean().optional(), compact: z.boolean().optional(), ...look }).strict(),
  Chart: z.object({
    type: z.enum(["line", "area", "bar", "hbar", "donut", "sparkline"]),
    labels: z.array(z.string().max(80)).max(400).default([]),
    series: z.array(z.object({ name: z.string().max(80), values: z.array(z.number().finite().nullable()).max(400), color: color.optional() }).strict()).min(1).max(8),
    stacked: z.boolean().optional(), axis: z.boolean().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), minor: z.boolean().optional(),
    height: z.number().min(24).max(600).optional(), ...look,
  }).strict(),
  Tabs: z.object({ tabs: z.array(z.object({ label: z.string().min(1).max(40), content: z.unknown() }).strict()).min(2).max(6), ...look }).strict(),
  Param: z.object({ name: z.string().max(40), variant: z.enum(["pills", "select"]).optional(), ...look }).strict(),
  Link: z.object({ to: linkTarget, ...look }).strict(),
  Style: z.object({ css: z.string().max(50000) }).strict(),
};
export type KitName = keyof typeof KIT;

export class CardTreeError extends Error {}

function attribute(name: string, raw: unknown, context: TreeContext): unknown {
  if (name === "style") return sanitizeStyle(raw);
  if (name === "id") {
    if (typeof raw !== "string" || !ID.test(raw)) throw new CardTreeError(`Invalid id ${JSON.stringify(raw)}`);
    return `${context.scope}-${raw}`;
  }
  if (name.startsWith("aria-")) {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") throw new CardTreeError(`Invalid ${name}`);
    return raw;
  }
  if (!ATTRIBUTES.has(name)) throw new CardTreeError(`Attribute ${name} is not allowed`);
  const parsed = value.safeParse(raw);
  if (!parsed.success) throw new CardTreeError(`Attribute ${name} must be text or a number`);
  if (typeof parsed.data === "string") {
    const local = LOCAL_URL.exec(parsed.data.trim());
    if (local) return `url(#${context.scope}-${local[1]})`;
    if (UNSAFE_VALUE.test(parsed.data)) throw new CardTreeError(`Attribute ${name} has a value that is not allowed`);
  }
  return parsed.data;
}

function sanitizeStyle(raw: unknown) {
  const parsed = style.safeParse(raw);
  if (!parsed.success) throw new CardTreeError("style must be an object of CSS properties");
  for (const [property, entry] of Object.entries(parsed.data ?? {}))
    if (typeof entry === "string" && UNSAFE_VALUE.test(entry) || /^(behavior|MozBinding)$/i.test(property)) throw new CardTreeError(`style.${property} is not allowed`);
  return parsed.data;
}

/** Card CSS applies only inside the card: every selector is prefixed, keyframes are renamed, and nothing can load. */
export function scopeCss(css: string, scope: string) {
  const root = postcss.parse(css);
  const keyframes = new Map<string, string>();
  root.walkAtRules(rule => {
    const name = rule.name.toLowerCase();
    if (name.endsWith("keyframes")) { const renamed = `${scope}-${rule.params.trim()}`; keyframes.set(rule.params.trim(), renamed); rule.params = renamed; }
    else if (!["media", "supports", "container"].includes(name)) rule.remove();
  });
  root.walkRules(rule => {
    if (rule.parent?.type === "atrule" && (rule.parent as postcss.AtRule).name.toLowerCase().endsWith("keyframes")) return;
    rule.selectors = rule.selectors.map(selector => selector.replace(/^\s*(:root|html|body)\b/, "").trim()).map(selector => selector ? `[data-card="${scope}"] ${selector}` : `[data-card="${scope}"]`);
  });
  root.walkDecls(decl => {
    if (UNSAFE_VALUE.test(decl.value) || UNSAFE_VALUE.test(decl.prop) || /^(behavior|-moz-binding)$/i.test(decl.prop)) { decl.remove(); return; }
    if (/^animation(-name)?$/i.test(decl.prop)) decl.value = decl.value.replace(/[\w-]+/g, word => keyframes.get(word) ?? word);
  });
  // "<" can never close the <style> element the CSS is rendered in.
  return root.toString().replace(/</g, "\\3c ");
}

/** A checked copy of the tree; throws CardTreeError with the reason for the designer to fix. */
export function sanitizeTree(node: unknown, context: TreeContext): CardNode {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") throw new CardTreeError("A card must return elements");
  const { type, props = {}, children = [] } = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  if (typeof type !== "string" || typeof props !== "object" || !Array.isArray(children)) throw new CardTreeError("Malformed element");
  const kids = () => children.map(child => sanitizeTree(child, context));
  if (type === "#fragment") return { type, props: {}, children: kids() };
  if (type.startsWith("kit:")) {
    const name = type.slice(4) as KitName;
    if (!Object.hasOwn(KIT, name)) throw new CardTreeError(`Kit.${name} does not exist`);
    const rest = Object.fromEntries(Object.entries(props).filter(([prop]) => prop !== "key" && prop !== "children"));
    const parsed = KIT[name].safeParse(rest);
    if (!parsed.success) throw new CardTreeError(`Kit.${name}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    const checked = parsed.data as Record<string, unknown>;
    if ("style" in checked) checked.style = sanitizeStyle(checked.style);
    if (name === "Style") checked.css = scopeCss(checked.css as string, context.scope);
    if (name === "Tabs") checked.tabs = (checked.tabs as { label: string; content: unknown }[]).map(tab => ({ label: tab.label, content: sanitizeTree(tab.content ?? "", context) }));
    return { type, props: checked, children: name === "Link" ? kids() : [] };
  }
  if (!ELEMENTS.has(type)) throw new CardTreeError(`<${type}> is not allowed`);
  const safe: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(props)) {
    if (name === "key" || name === "children" || raw === undefined || raw === null || raw === false) continue;
    safe[name] = attribute(name, raw, context);
  }
  return { type, props: safe, children: kids() };
}
