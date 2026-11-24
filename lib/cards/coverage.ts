import type { CardNode } from "./sandbox";
import type { CardSize } from "./sizes";

type DataList = { path: string; labels: string[] };

const MIN_LABEL_LENGTH = 3;
const MORE_LINE = /\+\s*\d+\s*more|\b\d+\s+(more|others)\b/i;
const NOT_A_NAME_KEY = /formatted|minor|(^|_)id$|Id$|date|At$|currency|color|colour/i;
const NOT_A_NAME_VALUE = /^\d{4}-\d{2}-\d{2}|^[\d\s.,:%+\-−€$£¥]+$/;

function nameKey(items: Record<string, unknown>[]) {
  let best: { key: string; distinct: number } | null = null;
  const keys = new Set(items.flatMap(item => Object.keys(item)));
  for (const key of keys) {
    if (NOT_A_NAME_KEY.test(key)) continue;
    const values = items.map(item => item[key]);
    if (!values.every(value => typeof value === "string" && value.trim().length >= MIN_LABEL_LENGTH && !NOT_A_NAME_VALUE.test(value.trim()))) continue;
    const distinct = new Set(values).size;
    if (distinct === items.length && (!best || distinct > best.distinct)) best = { key, distinct };
  }
  return best?.key ?? null;
}

export function dataLists(data: unknown, path = "", found: DataList[] = []): DataList[] {
  if (Array.isArray(data)) {
    const objects = data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    if (data.length >= 2 && objects.length === data.length) {
      const key = nameKey(objects);
      if (key) found.push({ path: path || "data", labels: objects.map(item => String(item[key]).trim()) });
    }
    objects.slice(0, 1).forEach(item => dataLists(item, `${path}[]`, found));
    return found;
  }
  if (data && typeof data === "object") for (const [key, value] of Object.entries(data)) dataLists(value, path ? `${path}.${key}` : key, found);
  return found;
}

const strings = (value: unknown): string[] => typeof value === "string" ? [value] : typeof value === "number" ? [String(value)]
  : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const hiddenInline = (props: Record<string, unknown>) => {
  const style = props.style as Record<string, unknown> | undefined;
  return style?.display === "none" || style?.visibility === "hidden";
};

function visibleText(node: CardNode): string {
  if (typeof node === "string") return node;
  if (hiddenInline(node.props)) return "";
  if (node.type === "kit:Style") return "";
  if (node.type.startsWith("kit:")) {
    const { tabs, ...props } = node.props;
    const panels = Array.isArray(tabs) ? (tabs as { label: string; content: CardNode }[]).map(tab => `${tab.label}\n${visibleText(tab.content)}`) : [];
    return [...strings(props), ...panels, ...node.children.map(visibleText)].join("\n");
  }
  const inline = node.children.every(child => typeof child === "string");
  return node.children.map(visibleText).join(inline ? "" : "\n");
}

export function rowCoverage(data: unknown, trees: Partial<Record<CardSize, CardNode>>): string[] {
  const texts = Object.entries(trees).map(([size, tree]) => ({ size, text: visibleText(tree as CardNode) }));
  const hidden: string[] = [];
  for (const list of dataLists(data)) {
    const counts = texts.map(({ size, text }) => ({ size, text, shown: list.labels.filter(label => text.includes(label)).length }));
    if (!counts.some(count => count.shown >= 2)) continue;
    for (const { size, text, shown } of counts) {
      if (!shown || shown >= list.labels.length) continue;
      hidden.push(`${size} shows ${shown} of ${list.labels.length} ${list.path}${MORE_LINE.test(text) ? ' and says "+N more"' : ", with nothing saying the rest are left out"}`);
    }
  }
  return hidden;
}
