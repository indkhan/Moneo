import { formatMoney } from "@/lib/finance/format";

export function CalculatorRows({ rows, currency, locale }: {
  rows: Record<string, unknown>[]; currency?: string; locale?: string;
}) {
  const visible = rows.slice(0, 20);
  const columns = [...new Set(visible.flatMap(row => Object.keys(row)))];
  function value(key: string, cell: unknown, row: Record<string, unknown>) {
    const code = typeof row.currency === "string" ? row.currency : currency;
    if (key.endsWith("Minor") && typeof cell === "string" && /^-?\d+$/.test(cell) && code && /^[A-Z]{3}$/.test(code))
      return formatMoney(cell, code, locale);
    return cell === null || cell === undefined ? "—" : typeof cell === "object" ? JSON.stringify(cell) : String(cell);
  }
  return <div className="mt-4 overflow-x-auto rounded-lg border border-border">
    <table className="w-full text-left text-xs"><caption className="sr-only">Calculator results</caption>
      <thead className="bg-muted"><tr>{columns.map(key => <th key={key} scope="col" className="px-3 py-2 font-medium">{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</th>)}</tr></thead>
      <tbody>{visible.map((row, index) => <tr key={index} className="border-t border-border">{columns.map(key => <td key={key} className="px-3 py-2">{value(key, row[key], row)}</td>)}</tr>)}</tbody>
    </table>
    {rows.length > visible.length && <p className="p-3 text-xs text-muted-foreground">Showing {visible.length} of {rows.length} rows. Exports include all rows.</p>}
  </div>;
}
