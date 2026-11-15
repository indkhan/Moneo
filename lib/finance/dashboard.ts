import { z } from "zod";
import { CARD_SIZE_KEYS, type CardSize } from "@/lib/cards/sizes";

export const BUILTIN_WIDGETS = { overview: "Net worth", insights: "Weekly briefing", upcoming: "Coming up", spending: "Cash flow over six months, with where money came from and went",
  budgets: "Budgets", accounts: "Accounts", agents: "Agent team", history: "History of recent changes", recent: "Recent transactions", planning: "Available funds by account", goals: "Goals" };
const DEFAULT_WIDGETS = ["overview", "insights", "upcoming", "spending", "budgets", "accounts", "agents", "history"];
const CARD_KEY = /^card:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const isWidgetKey = (key: string) => Object.hasOwn(BUILTIN_WIDGETS, key) || CARD_KEY.test(key);
export const dashboardLayoutSchema = z.array(z.string()).max(50)
  .transform(items => items.filter(key => !/^artifact:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)))
  .pipe(z.array(z.string().refine(isWidgetKey)).refine(items => new Set(items).size === items.length, "Widgets must be unique"));

export const cardWidgetKey = (id: string) => `card:${id.toLowerCase()}`;
export const cardIdFromKey = (key: string) => CARD_KEY.exec(key)?.[1] ?? null;

export function dashboardItems(saved: string[] | null) {
  return [...new Set(saved ?? DEFAULT_WIDGETS)].filter(isWidgetKey);
}

export function setWidget(items: string[], key: string, on: boolean) {
  if (!on) return items.filter(item => item !== key);
  if (items.includes(key)) return items;
  const at = items.indexOf("overview") + 1;
  return [...items.slice(0, at), key, ...items.slice(at)];
}

type BuiltinWidget = keyof typeof BUILTIN_WIDGETS;
export const isBuiltinWidget = (key: string): key is BuiltinWidget => Object.hasOwn(BUILTIN_WIDGETS, key);
const DEFAULT_SIZES: Record<BuiltinWidget, CardSize> = { overview: "L", history: "XL", spending: "L", insights: "L", recent: "L", accounts: "M", agents: "M",
  upcoming: "S", budgets: "S", planning: "S", goals: "S" };
const MIN_SIZES: Partial<Record<BuiltinWidget, CardSize>> = { overview: "M", spending: "M", insights: "M" };

export const widgetSizesSchema = z.record(z.string(), z.unknown()).transform(saved =>
  Object.fromEntries(Object.entries(saved).filter((entry): entry is [BuiltinWidget, CardSize] =>
    isBuiltinWidget(entry[0]) && sizeOptions(entry[0]).includes(entry[1] as CardSize))));

export function sizeOptions(key: string): CardSize[] {
  return isBuiltinWidget(key) && MIN_SIZES[key] ? CARD_SIZE_KEYS.slice(CARD_SIZE_KEYS.indexOf(MIN_SIZES[key])) : CARD_SIZE_KEYS;
}

export const widgetLabel = (key: BuiltinWidget) => BUILTIN_WIDGETS[key].split(",")[0];

export function homeLayout(row: { items: unknown; sizes?: unknown; version?: number } | null) {
  const items = row ? dashboardLayoutSchema.safeParse(row.items) : null;
  if (items && !items.success) return null;
  return { items: dashboardItems(items?.data ?? null), sizes: widgetSizesSchema.safeParse(row?.sizes ?? {}).data ?? {}, version: row?.version ?? 0 };
}

export const widgetSize = (key: BuiltinWidget, sizes: Partial<Record<string, CardSize>>): CardSize => sizes[key] ?? DEFAULT_SIZES[key];
