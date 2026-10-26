import { z } from "zod";

// Keys are stored in saved layouts; never rename one. Key order is the order offered in Settings.
export const BUILTIN_WIDGETS = { overview: "Overview", insights: "Weekly briefing", upcoming: "Coming up", spending: "Cash flow over six months, with where money came from and went",
  budgets: "Budgets", accounts: "Accounts", agents: "Agent team", history: "History of recent changes", recent: "Recent transactions", planning: "Available funds by account", goals: "Goals" };
// Home without a saved layout; the rest stay available in Settings.
const DEFAULT_WIDGETS = ["overview", "insights", "upcoming", "spending", "budgets", "accounts", "agents", "history"];
// Artifacts pinned to Home are stored as "artifact:<uuid>" next to the built-in keys.
const ARTIFACT_KEY = /^artifact:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const isWidgetKey = (key: string) => Object.hasOwn(BUILTIN_WIDGETS, key) || ARTIFACT_KEY.test(key);
export const dashboardLayoutSchema = z.array(z.string().refine(isWidgetKey)).max(50).refine(items => new Set(items).size === items.length, "Widgets must be unique");

export const artifactWidgetKey = (id: string) => `artifact:${id.toLowerCase()}`;
export const artifactIdFromKey = (key: string) => ARTIFACT_KEY.exec(key)?.[1] ?? null;

export function dashboardItems(saved: string[] | null) {
  return [...new Set(saved ?? DEFAULT_WIDGETS)].filter(isWidgetKey);
}

/** Adds a widget just below the overview (or first), so a newly pinned artifact is seen; or removes it. */
export function setWidget(items: string[], key: string, on: boolean) {
  if (!on) return items.filter(item => item !== key);
  if (items.includes(key)) return items;
  const at = items.indexOf("overview") + 1;
  return [...items.slice(0, at), key, ...items.slice(at)];
}
