import type { WealthItem } from "@/lib/finance/wealth";
import { formatMoney } from "@/lib/finance/format";
import { directionOf, percentText } from "./delta";
import { toMinor } from "./live";
import type { ScalablePortfolio } from "./portfolio";

export function holdingRows(items: WealthItem[], portfolio: ScalablePortfolio, locale: string) {
  const held = new Set(portfolio.itemIds ?? []);
  return items.filter(item => item.kind === "holding" && held.has(item.id))
    .sort((a, b) => Number(BigInt(b.amount_minor) - BigInt(a.amount_minor)))
    .map(item => {
      const value = BigInt(item.amount_minor), cost = item.cost_basis_minor === null ? null : BigInt(item.cost_basis_minor);
      const money = (minor: bigint | string) => formatMoney(minor, item.currency_code, locale);
      return {
        id: item.id, name: item.name, value: money(value),
        position: `${item.quantity_text} × ${item.unit_price_text ? money(toMinor(item.unit_price_text, item.currency_code)) : "—"}`,
        gain: cost === null ? null : { direction: directionOf(value - cost), text: [`${value > cost ? "+" : ""}${money(value - cost)}`, percentText(value - cost, cost)].filter(Boolean).join(" · ") },
      };
    });
}
