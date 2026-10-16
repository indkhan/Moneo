import { formatMoney } from "@/lib/finance/format";

// "averageMinorPerDay" -> "Average per day"; amounts are labelled by currency, not unit.
export function outputLabel(key: string) {
  const words = key.replace(/_minor$|Minor(?=[A-Z]|$)/, "").replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

export function outputValue(key: string, value: string | number, currency?: string, locale?: string) {
  if (/(?:Minor|_minor)$/.test(key) && currency && /^[A-Z]{3}$/.test(currency) && (typeof value === "string" ? /^-?\d+$/.test(value) : Number.isSafeInteger(value))) {
    try { return formatMoney(value, currency, locale); } catch { /* Unsupported currency: keep the exact literal. */ }
  }
  return String(value);
}

export function CalculatorRows({ rows, currency, locale }: {
  rows: Record<string, unknown>[]; currency?: string; locale?: string;
}) {
  const visible = rows.slice(0, 20);
  const columns = [...new Set(visible.flatMap(row => Object.keys(row)))];
  function value(key: string, cell: unknown, row: Record<string, unknown>) {
    if (typeof cell === "string" || typeof cell === "number") return outputValue(key, cell, typeof row.currency === "string" ? row.currency : currency, locale);
    return cell === null || cell === undefined ? "—" : JSON.stringify(cell);
  }
  return <div className="overflow-x-auto rounded-lg border border-border">
    <table className="w-full text-left text-xs"><caption className="sr-only">Calculator results</caption>
      <thead className="bg-muted text-muted-foreground"><tr>{columns.map(key => <th key={key} scope="col" className="px-3 py-2 font-medium">{outputLabel(key)}</th>)}</tr></thead>
      <tbody>{visible.map((row, index) => <tr key={index} className="border-t border-border">{columns.map(key => <td key={key} className="px-3 py-2 tabular-nums">{value(key, row[key], row)}</td>)}</tr>)}</tbody>
    </table>
    {rows.length > visible.length && <p className="p-3 text-xs text-muted-foreground">Showing {visible.length} of {rows.length} rows. Exports include all rows.</p>}
  </div>;
}
