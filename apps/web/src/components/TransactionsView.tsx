"use client";

import * as React from "react";
import { formatMoney } from "@moneo/shared/money";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EmptyState, Skeleton } from "@moneo/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createClient,
  type Account,
  type Transaction,
  type TransactionSort,
} from "../generated/client";
import { TransactionDetailDrawer } from "./TransactionDetailDrawer";

/**
 * Issue 4.7 — Money → Transactions.
 *
 * Server owns filter/sort/page: `useInfiniteQuery` walks the keyset cursor,
 * `useReactTable` renders cells only (no client sorting/filtering —
 * `getCoreRowModel` alone), and `useVirtualizer` renders the visible window
 * with spacer rows so a large import never mounts its full dataset. Amounts
 * stay decimal strings from the wire to `BigInt` here; no float touches
 * money on this page.
 */

const PAGE_SIZE = 50;
const ROW_HEIGHT = 44;

export interface TransactionFilters {
  q: string;
  direction: "" | "credit" | "debit";
  accountId: string;
  sort: TransactionSort;
}

const EMPTY_FILTERS: TransactionFilters = { q: "", direction: "", accountId: "", sort: "newest" };

function useDebounced(value: string, delayMs: number): string {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrent(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return current;
}

export function formatTransactionAmount(row: Transaction): string {
  return formatMoney(
    { amountMinor: BigInt(row.amountMinor), currency: row.currencyCode, direction: row.direction },
    "en-GB",
  );
}

const columnHelper = createColumnHelper<Transaction & { accountName: string }>();

const columns = [
  columnHelper.accessor("effectiveDate", { header: "Date" }),
  columnHelper.accessor("description", { header: "Description" }),
  columnHelper.accessor("accountName", { header: "Account" }),
  columnHelper.accessor("direction", { header: "Direction" }),
  columnHelper.accessor("amountMinor", {
    header: "Amount",
    cell: (info) => formatTransactionAmount(info.row.original),
  }),
];

/** Pure table: renders exactly the rows it is given (virtual window or full page). */
export function TransactionsTable({
  rows,
  padTop,
  padBottom,
  onSelect,
}: {
  rows: (Transaction & { accountName: string })[];
  padTop?: number;
  padBottom?: number;
  /** When set, each row gains a View control that reports its transaction id. */
  onSelect?: (transactionId: string) => void;
}) {
  const tableColumns = React.useMemo(
    () =>
      onSelect
        ? [
            ...columns,
            columnHelper.display({
              id: "details",
              header: "Details",
              cell: (info) => (
                <button
                  type="button"
                  aria-label={`View ${info.row.original.description}`}
                  onClick={() => {
                    onSelect(info.row.original.id);
                  }}
                >
                  View
                </button>
              ),
            }),
          ]
        : columns,
    [onSelect],
  );
  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
  });
  const columnCount = table.getAllColumns().length;
  const tableRows = table.getRowModel().rows;
  return (
    <table aria-label="Transactions" style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th
                key={header.id}
                scope="col"
                style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #2a3442" }}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {(padTop ?? 0) > 0 ? (
          <tr aria-hidden="true">
            <td colSpan={columnCount} style={{ height: padTop, padding: 0, border: 0 }} />
          </tr>
        ) : null}
        {tableRows.map((tableRow) => (
          <tr key={tableRow.original.id} style={{ height: ROW_HEIGHT }}>
            {tableRow.getVisibleCells().map((cell) => (
              <td key={cell.id} style={{ padding: "8px", borderBottom: "1px solid #1c2530" }}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
        {(padBottom ?? 0) > 0 ? (
          <tr aria-hidden="true">
            <td colSpan={columnCount} style={{ height: padBottom, padding: 0, border: 0 }} />
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export function TransactionsView() {
  const client = useMemo(() => createClient(), []);
  const [filters, setFilters] = useState<TransactionFilters>(EMPTY_FILTERS);
  // Overlay selection only: the list and its filters stay mounted behind
  // the drawer, so opening a row never loses list position or filters.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debouncedQ = useDebounced(filters.q, 300);
  const active = useMemo(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: () => client.listAccounts(),
  });
  const accountsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accountsQuery.data?.items ?? []) {
      map.set(account.id, account.name);
    }
    return map;
  }, [accountsQuery.data]);

  const search = useInfiniteQuery({
    queryKey: ["transactions", active],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      client.searchTransactions({
        ...(active.q ? { q: active.q } : {}),
        ...(active.direction ? { directions: active.direction } : {}),
        ...(active.accountId ? { accountIds: active.accountId } : {}),
        sort: active.sort,
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor,
  });

  const rows = useMemo(
    () =>
      (search.data?.pages ?? [])
        .flatMap((page) => page.items)
        .map((item) => ({
          ...item,
          accountName: accountsById.get(item.accountId) ?? "Unknown account",
        })),
    [search.data, accountsById],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visible =
    virtualItems.length > 0 ? rows.filter((_, i) => virtualItems.some((v) => v.index === i)) : rows;
  const padTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const padBottom =
    virtualItems.length > 0
      ? virtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1]?.end ?? 0)
      : 0;

  const hasFilters = active.q !== "" || active.direction !== "" || active.accountId !== "";

  return (
    <section aria-labelledby="transactions-heading" style={{ display: "grid", gap: 12 }}>
      <h1 id="transactions-heading" style={{ margin: 0, fontSize: 24 }}>
        Transactions
      </h1>
      <form
        aria-label="Transaction filters"
        onSubmit={(event) => {
          event.preventDefault();
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <label>
          Search{" "}
          <input
            type="search"
            value={filters.q}
            onChange={(event) => {
              setFilters({ ...filters, q: event.target.value });
            }}
            placeholder="Coffee"
          />
        </label>
        <label>
          Direction{" "}
          <select
            value={filters.direction}
            onChange={(event) => {
              setFilters({
                ...filters,
                direction: event.target.value as TransactionFilters["direction"],
              });
            }}
          >
            <option value="">All</option>
            <option value="credit">Credit</option>
            <option value="debit">Debit</option>
          </select>
        </label>
        <label>
          Account{" "}
          <select
            value={filters.accountId}
            onChange={(event) => {
              setFilters({ ...filters, accountId: event.target.value });
            }}
          >
            <option value="">All accounts</option>
            {(accountsQuery.data?.items ?? []).map((account: Account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort{" "}
          <select
            value={filters.sort}
            onChange={(event) => {
              setFilters({ ...filters, sort: event.target.value as TransactionSort });
            }}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </form>

      {search.isPending ? (
        <div aria-label="Loading transactions" style={{ display: "grid", gap: 8 }}>
          <Skeleton style={{ height: 44 }} />
          <Skeleton style={{ height: 44 }} />
          <Skeleton style={{ height: 44 }} />
        </div>
      ) : search.isError ? (
        <div role="alert">
          <p>Could not load transactions.</p>
          <button
            type="button"
            onClick={() => {
              void search.refetch();
            }}
          >
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No transactions found"
          description={
            hasFilters
              ? "No transactions match these filters."
              : "Import a statement to get started."
          }
        />
      ) : (
        <>
          <p aria-live="polite" style={{ margin: 0 }}>
            {rows.length} loaded
            {search.hasNextPage ? " (more available)" : ""}
          </p>
          <div ref={parentRef} style={{ height: 480, overflow: "auto" }}>
            <TransactionsTable
              rows={visible}
              padTop={padTop}
              padBottom={padBottom}
              onSelect={setSelectedId}
            />
          </div>
          {selectedId ? (
            <TransactionDetailDrawer
              transactionId={selectedId}
              onClose={() => {
                setSelectedId(null);
              }}
            />
          ) : null}
          {search.hasNextPage ? (
            <button
              type="button"
              disabled={search.isFetchingNextPage}
              onClick={() => {
                void search.fetchNextPage();
              }}
            >
              {search.isFetchingNextPage ? "Loading more…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
