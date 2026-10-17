import { z } from "zod";

// Key order is the default Home order. Keys are stored in saved layouts; never rename one.
export const BUILTIN_WIDGETS = { overview: "Overview", spending: "Spending trend, categories and merchants", recent: "Recent transactions", insights: "Important insights",
  upcoming: "Upcoming payments", planning: "Available funds by account", accounts: "Accounts", goals: "Goals" };
export const dashboardLayoutSchema = z.array(z.string().refine(key => Object.hasOwn(BUILTIN_WIDGETS, key) || /^tool:[0-9a-f-]{36}$/.test(key))).max(50).refine(items => new Set(items).size === items.length, "Widgets must be unique");

export function dashboardItems(saved: string[] | null, pins: string[]) {
  const tools = pins.map(id => `tool:${id}`);
  const items = [...new Set(saved ?? Object.keys(BUILTIN_WIDGETS))].filter(key => Object.hasOwn(BUILTIN_WIDGETS, key) || tools.includes(key));
  return [...items, ...tools.filter(key => !items.includes(key))];
}
