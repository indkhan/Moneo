import { z } from "zod";

export const BUILTIN_WIDGETS = { overview: "Net worth and ledger", planning: "Spending and available funds", accounts: "Accounts", upcoming: "Upcoming payments", goals: "Goals", insights: "Important insights" };
export const dashboardLayoutSchema = z.array(z.string().refine(key => Object.hasOwn(BUILTIN_WIDGETS, key) || /^tool:[0-9a-f-]{36}$/.test(key))).max(50).refine(items => new Set(items).size === items.length, "Widgets must be unique");

export function dashboardItems(saved: string[] | null, pins: string[]) {
  const tools = pins.map(id => `tool:${id}`);
  const items = [...new Set(saved ?? Object.keys(BUILTIN_WIDGETS))].filter(key => Object.hasOwn(BUILTIN_WIDGETS, key) || tools.includes(key));
  return [...items, ...tools.filter(key => !items.includes(key))];
}
