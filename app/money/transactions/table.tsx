"use client";

import Link from "next/link";
import { type ColumnDef, type CoreFeatures } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";

type Row = { id: string; posted_on: string; description: string; amount_minor: string; currency_code: string; status: string; kind: string; account_id: string };

function amount(minor: string, currency: string) {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${currency} ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function TransactionTable({ rows, accountNames, query }: { rows: Row[]; accountNames: Record<string, string>; query: string }) {
  const columns: ColumnDef<CoreFeatures, Row>[] = [
    { accessorKey: "posted_on", header: "Date" },
    { accessorKey: "description", header: "Description", cell: ({ row }) => <Link className="underline" href={`/money/transactions?${query}${query ? "&" : ""}transaction=${row.original.id}`}>{row.original.description}</Link> },
    { accessorKey: "account_id", header: "Account", cell: ({ row }) => accountNames[row.original.account_id] ?? "Unknown" },
    { accessorKey: "amount_minor", header: "Amount", cell: ({ row }) => amount(row.original.amount_minor, row.original.currency_code) },
    { accessorKey: "kind", header: "Type" },
    { accessorKey: "status", header: "Status" },
  ];
  return <div className="mt-6 overflow-x-auto">{rows.length ? <DataTable data={rows} columns={columns} /> : <p className="text-muted-foreground">No transactions found.</p>}</div>;
}
