import { formatMoney } from "@/lib/finance/format";
import { parseManualAmount } from "./input";
import type { FilterValues } from "./filter-bar";

// Compiles a plain-language query ("coffee over €5 last month") into the
// existing URL filter model. Deterministic: every value it sets is shown back
// as a chip, and anything it does not understand becomes a description search.

type Named = { id: string; name: string };
type CompiledFilter = { params: FilterValues; understood: string[] };

const MONTHS = ["january|jan", "february|feb", "march|mar", "april|apr", "may", "june|jun", "july|jul", "august|aug", "september|sept|sep", "october|oct", "november|nov", "december|dec"];
const SYMBOLS: Record<string, string> = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY" };
const STOP = new Set(["show", "me", "all", "my", "transactions", "transaction", "payments", "payment", "at", "on", "for", "in", "from", "with", "the", "a", "an", "and", "of", "to", "find", "list", "what", "did", "i", "spend", "spent", "spending", "purchases", "purchase", "paid", "expenses", "charges", "money", "out", "income", "received", "earned", "deposits", "than", "sorted", "by", "first"]);
const iso = (date: Date) => date.toISOString().slice(0, 10);
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const shift = (value: string, days: number) => iso(new Date(day(value).getTime() + days * 86_400_000));
const monthRange = (year: number, month: number) => [iso(new Date(Date.UTC(year, month, 1))), iso(new Date(Date.UTC(year, month + 1, 0)))] as const;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function compileFilterQuery(input: string, options: { today: string; currency: string; accounts: Named[]; categories: Named[]; merchants: Named[] }): CompiledFilter {
  const params: FilterValues = {}, understood: string[] = [];
  let text = ` ${input.trim().slice(0, 200).toLowerCase()} `;
  const take = (pattern: RegExp, apply: (match: RegExpMatchArray) => string | void) => {
    const match = text.match(pattern);
    if (!match) return;
    const label = apply(match);
    if (!label) return; // Unparsed text stays in the description search.
    understood.push(label);
    text = text.replace(match[0], " ");
  };
  const [year, month] = [Number(options.today.slice(0, 4)), Number(options.today.slice(5, 7)) - 1];

  // Direction words decide the amount sign: spending is negative in the ledger.
  const income = /\b(income|received|earned|salary|deposits?|money in)\b/.test(text);
  if (income) { params.direction = "income"; understood.push("Money in"); }
  else if (/\b(spent|spending|spend|purchases?|paid|expenses?|charges?|money out)\b/.test(text)) { params.direction = "outflow"; understood.push("Money out"); }

  const money = String.raw`([€$£¥])?\s?(\d+(?:[.,]\d{1,2})?)\s?(€|eur|usd|gbp|chf|\$|£)?`;
  const amount = (match: RegExpMatchArray, offset: number) => {
    const symbol = match[offset] ?? match[offset + 2];
    const currency = symbol ? SYMBOLS[symbol] ?? symbol.toUpperCase() : options.currency;
    if (currency !== options.currency) return null; // ponytail: no FX in filters; a foreign amount stays unparsed text.
    try { return { minor: parseManualAmount(match[offset + 1].replace(",", "."), options.currency), currency }; } catch { return null; }
  };
  const signed = (minor: bigint) => (income ? minor : -minor).toString();
  const display = (minor: bigint) => formatMoney(minor, options.currency);
  take(new RegExp(String.raw`\bbetween\s+${money}\s+and\s+${money}`), match => {
    const low = amount(match, 1), high = amount(match, 4);
    if (!low || !high) return;
    if (!params.direction) { params.direction = "outflow"; understood.push("Money out"); }
    if (income) { params.minAmount = signed(low.minor); params.maxAmount = signed(high.minor); }
    else { params.minAmount = signed(high.minor); params.maxAmount = signed(low.minor); }
    return `Between ${display(low.minor)} and ${display(high.minor)}`;
  });
  for (const [words, above] of [[String.raw`over|above|more than|greater than|at least|>=?|min(?:imum)?`, true], [String.raw`under|below|less than|at most|<=?|max(?:imum)?|up to`, false]] as const) {
    take(new RegExp(String.raw`(?:^|\s)(?:${words})\s*${money}`), match => {
      const value = amount(match, 1);
      if (!value) return;
      if (!params.direction) { params.direction = "outflow"; understood.push("Money out"); }
      // "Over 5" spending means amount <= -5; for income it means amount >= 5.
      if (above === !income) params.maxAmount = signed(value.minor); else params.minAmount = signed(value.minor);
      return `${above ? "Over" : "Under"} ${display(value.minor)}`;
    });
  }

  // Dates.
  const set = (from: string, to: string, label: string) => { params.from = from; params.to = to; return label; };
  take(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|until|-|–)\s*(\d{4}-\d{2}-\d{2})\b/, match => set(match[1], match[2], `${match[1]} to ${match[2]}`));
  take(/\bsince\s+(\d{4}-\d{2}-\d{2})\b/, match => { params.from = match[1]; return `Since ${match[1]}`; });
  take(/\btoday\b/, () => set(options.today, options.today, "Today"));
  take(/\byesterday\b/, () => set(shift(options.today, -1), shift(options.today, -1), "Yesterday"));
  take(/\b(?:this|current) month\b/, () => set(monthRange(year, month)[0], options.today, "This month"));
  take(/\blast month\b/, () => set(...monthRange(year, month - 1), "Last month"));
  take(/\bthis year\b/, () => set(`${year}-01-01`, options.today, "This year"));
  take(/\blast year\b/, () => set(`${year - 1}-01-01`, `${year - 1}-12-31`, "Last year"));
  take(/\bthis week\b/, () => set(shift(options.today, -((day(options.today).getUTCDay() + 6) % 7)), options.today, "This week"));
  take(/\blast week\b/, () => { const start = shift(options.today, -((day(options.today).getUTCDay() + 6) % 7) - 7); return set(start, shift(start, 6), "Last week"); });
  take(/\b(?:last|past)\s+(\d{1,3})\s+(day|week|month)s?\b/, match => {
    const count = Number(match[1]), unit = match[2];
    const from = unit === "month" ? iso(new Date(Date.UTC(year, month - count, Number(options.today.slice(8, 10))))) : shift(options.today, -count * (unit === "week" ? 7 : 1));
    return set(from, options.today, `Last ${count} ${unit}s`);
  });
  take(new RegExp(String.raw`\b(${MONTHS.join("|")})\b\.?(?:\s+(\d{4})\b)?`), match => {
    const index = MONTHS.findIndex(names => names.split("|").includes(match[1]));
    const targetYear = match[2] ? Number(match[2]) : index > month ? year - 1 : year;
    const [from, to] = monthRange(targetYear, index);
    return set(from, to, new Date(Date.UTC(targetYear, index, 1)).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" }));
  });

  // Ledger semantics.
  take(/\bpending\b/, () => { params.status = "pending"; return "Pending"; });
  take(/\btransfers?\b/, () => { params.kind = "transfer"; return "Transfers"; });
  take(/\brefunds?\b/, () => { params.kind = "refund"; return "Refunds"; });
  take(/\buncategori[sz]ed\b/, () => { params.category = "none"; return "Uncategorized"; });
  take(/\bunknown merchants?\b/, () => { params.merchant = "none"; return "Unknown merchant"; });
  take(/#([\p{L}\p{N}_-]{1,40})/u, match => { params.tag = match[1]; return `Tag ${match[1]}`; });
  take(/\b(?:biggest|largest|highest)\b/, () => { params.sort = income ? "amount-desc" : "amount-asc"; return "Largest first"; });
  take(/\b(?:smallest|lowest)\b/, () => { params.sort = income ? "amount-asc" : "amount-desc"; return "Smallest first"; });
  take(/\boldest\b/, () => { params.sort = "date-asc"; return "Oldest first"; });
  take(/\b(?:grouped |group )?by (category|merchant|month)\b/, match => { params.group = match[1]; return `Grouped by ${match[1]}`; });

  // Owned names, longest first, so "Coffee Shop" wins over "Coffee".
  const named = (items: Named[], key: "category" | "merchant" | "account", label: string) => {
    if (params[key]) return;
    for (const item of [...items].sort((a, b) => b.name.length - a.name.length)) {
      const name = item.name.trim().toLowerCase();
      if (name.length < 2) continue;
      const pattern = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${escape(name)}s?(?=$|[^\p{L}\p{N}])`, "u");
      if (pattern.test(text)) { params[key] = item.id; understood.push(`${label}: ${item.name}`); text = text.replace(pattern, " "); return; }
    }
  };
  named(options.categories, "category", "Category");
  named(options.merchants, "merchant", "Merchant");
  named(options.accounts, "account", "Account");

  const rest = text.split(/\s+/).filter(word => word && !STOP.has(word) && !/^[€$£¥.,!?]+$/.test(word)).join(" ");
  if (rest) { params.q = rest.slice(0, 200); understood.push(`Description contains “${params.q}”`); }
  return { params, understood };
}
