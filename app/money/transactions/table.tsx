"use client";

import Link from "next/link";
import { type ColumnDef, type CoreFeatures } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { DEFAULT_SORT, toggleSort, type TransactionSort } from "./filters";

type Row = { id: string; posted_on: string; description: string; amount_minor: string; currency_code: string; status: string; kind: string; account_id: string; merchant_id?: string | null };

function amount(minor: string, currency: string) {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${currency} ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

function sortHref(baseQuery: string, sort: TransactionSort, column: "date" | "amount") {
  const next = toggleSort(sort, column);
  const params = new URLSearchParams(baseQuery);
  params.delete("cursor");
  params.delete("transaction");
  if (next === DEFAULT_SORT) params.delete("sort");
  else params.set("sort", next);
  const query = params.toString();
  return query ? `/money/transactions?${query}` : "/money/transactions";
}

export function TransactionTable({ rows, accountNames, merchantNames, query, sort, baseQuery }: { rows: Row[]; accountNames: Record<string, string>; merchantNames: Record<string, string>; query: string; sort: TransactionSort; baseQuery: string }) {
  const dateIndicator = sort === "date-desc" ? " ▼" : sort === "date-asc" ? " ▲" : "";
  const amountIndicator = sort === "amount-desc" ? " ▼" : sort === "amount-asc" ? " ▲" : "";
  const columns: ColumnDef<CoreFeatures, Row>[] = [
    { accessorKey: "posted_on", header: () => <Link className="underline" aria-label={`Sort by date (currently ${sort})`} href={sortHref(baseQuery, sort, "date")}>Date{dateIndicator}</Link> },
    { accessorKey: "description", header: "Description", cell: ({ row }) => <Link className="underline" href={`/money/transactions?${query}${query ? "&" : ""}transaction=${row.original.id}`}>{row.original.description}</Link> },
    { accessorKey: "account_id", header: "Account", cell: ({ row }) => accountNames[row.original.account_id] ?? "Unknown" },
    { accessorKey: "merchant_id", header: "Merchant", cell: ({ row }) => (row.original.merchant_id ? merchantNames[row.original.merchant_id] ?? "Unknown" : "Unknown") },
    { accessorKey: "amount_minor", header: () => <Link className="underline" aria-label={`Sort by amount (currently ${sort})`} href={sortHref(baseQuery, sort, "amount")}>Amount{amountIndicator}</Link>, cell: ({ row }) => amount(row.original.amount_minor, row.original.currency_code) },
    { accessorKey: "kind", header: "Type" },
    { accessorKey: "status", header: "Status" },
  ];
  return <div className="mt-6 overflow-x-auto">{rows.length ? <DataTable data={rows} columns={columns} /> : <p className="text-muted-foreground">No transactions found.</p>}</div>;
}
