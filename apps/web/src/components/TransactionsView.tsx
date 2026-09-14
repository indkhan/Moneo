"use client";

import * as React from "react";
import { formatMoney } from "@moneo/shared/money";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, EmptyState, Skeleton } from "@moneo/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createClient,
  type Account,
  type Transaction,
  type TransactionSort,
} from "../generated/client";
import { ManualTransactionForm } from "./ManualTransactionForm";
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
  categoryId: string;
  tagNames: string;
  direction: "" | "credit" | "debit";
  accountId: string;
  dateFrom: string;
  dateTo: string;
  sort: TransactionSort;
}

const EMPTY_FILTERS: TransactionFilters = {
  q: "",
  categoryId: "",
  tagNames: "",
  direction: "",
  accountId: "",
  dateFrom: "",
  dateTo: "",
  sort: "newest",
};
const ALL_COLUMNS = ["date", "description", "account", "direction", "amount"] as const;
type TransactionColumn = (typeof ALL_COLUMNS)[number];

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
  columnHelper.accessor("effectiveDate", { id: "date", header: "Date" }),
  columnHelper.accessor("description", { id: "description", header: "Description" }),
  columnHelper.accessor("accountName", { id: "account", header: "Account" }),
  columnHelper.accessor("direction", { id: "direction", header: "Direction" }),
  columnHelper.accessor("amountMinor", {
    id: "amount",
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
  selectedIds,
  onToggle,
  visibleColumns = ALL_COLUMNS,
}: {
  rows: (Transaction & { accountName: string })[];
  padTop?: number;
  padBottom?: number;
  /** When set, each row gains a View control that reports its transaction id. */
  onSelect?: (transactionId: string) => void;
  selectedIds?: ReadonlySet<string>;
  onToggle?: (transactionId: string) => void;
  visibleColumns?: readonly TransactionColumn[];
}) {
  const tableColumns = React.useMemo(
    () =>
      onSelect || onToggle
        ? [
            ...(onToggle
              ? [
                  columnHelper.display({
                    id: "select",
                    header: "Select",
                    cell: (info) => (
                      <input
                        type="checkbox"
                        aria-label={`Select ${info.row.original.description}`}
                        checked={selectedIds?.has(info.row.original.id) ?? false}
                        onChange={() => {
                          onToggle(info.row.original.id);
                        }}
                      />
                    ),
                  }),
                ]
              : []),
            ...columns.filter((column) => visibleColumns.includes(column.id as TransactionColumn)),
            ...(onSelect
              ? [
                  columnHelper.display({
                    id: "details",
                    header: "Details",
                    cell: (info) => (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        aria-label={`View ${info.row.original.description}`}
                        onClick={() => {
                          onSelect(info.row.original.id);
                        }}
                      >
                        View
                      </Button>
                    ),
                  }),
                ]
              : []),
          ]
        : columns,
    [onSelect, onToggle, selectedIds, visibleColumns],
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

export function TransactionsView({
  initialQ = "",
  initialDateFrom = "",
  initialDateTo = "",
  initialSelectedId = null,
}: {
  initialQ?: string;
  initialDateFrom?: string;
  initialDateTo?: string;
  initialSelectedId?: string | null;
}) {
  const client = useMemo(() => createClient(), []);
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<TransactionFilters>({
    ...EMPTY_FILTERS,
    q: initialQ,
    dateFrom: initialDateFrom,
    dateTo: initialDateTo,
  });
  // Overlay selection only: the list and its filters stay mounted behind
  // the drawer, so opening a row never loses list position or filters.
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkWorking, setBulkWorking] = useState(false);
  const [bulkTags, setBulkTags] = useState("");
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [visibleColumns, setVisibleColumns] = useState<TransactionColumn[]>([...ALL_COLUMNS]);
  const [viewName, setViewName] = useState("");
  const [savedViewId, setSavedViewId] = useState("");
  const [frozenSelectionId, setFrozenSelectionId] = useState<string | null>(null);
  const [bulkMessage, setBulkMessage] = useState("");
  const [recording, setRecording] = useState(false);
  const debouncedQ = useDebounced(filters.q, 300);
  const active = useMemo(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: () => client.listAccounts(),
  });
  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: () => client.listCategories(),
  });
  const viewsQuery = useQuery({
    queryKey: ["transaction-views"],
    queryFn: () => client.listTransactionViews(),
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
        ...(active.categoryId ? { categoryIds: active.categoryId } : {}),
        ...(active.tagNames ? { tagNames: active.tagNames } : {}),
        ...(active.direction ? { directions: active.direction } : {}),
        ...(active.accountId ? { accountIds: active.accountId } : {}),
        ...(active.dateFrom ? { dateFrom: active.dateFrom } : {}),
        ...(active.dateTo ? { dateTo: active.dateTo } : {}),
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

  const hasFilters =
    filters.categoryId !== "" ||
    filters.tagNames !== "" ||
    active.q !== "" ||
    active.direction !== "" ||
    active.accountId !== "" ||
    active.dateFrom !== "" ||
    active.dateTo !== "";

  async function runBulk(
    command:
      | "transactions.excludeFromAnalyticsBulk"
      | "transactions.setCategoryBulk"
      | "transactions.addTagsBulk",
    input: Record<string, unknown>,
  ) {
    if (selectedIds.size === 0 && !frozenSelectionId) return;
    setBulkWorking(true);
    try {
      const selection = frozenSelectionId
        ? { id: frozenSelectionId, count: 0 }
        : await client.createFrozenTransactionSelection({ ids: [...selectedIds] });
      const outcome = await client.executeCommand(command, {
        metadata: { idempotencyKey: crypto.randomUUID() },
        input: { selectionId: selection.id, ...input },
      });
      setSelectedIds(new Set());
      setFrozenSelectionId(null);
      const result = outcome.result as {
        applied: number;
        replayed: number;
        conflicts: string[];
        missing: string[];
      };
      setBulkMessage(
        `${result.applied} updated; ${result.replayed} already applied; ${result.conflicts.length} stale rows skipped; ${result.missing.length} unavailable rows skipped.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["transactions"] });
    } catch {
      setBulkMessage("Bulk update could not be completed.");
    } finally {
      setBulkWorking(false);
    }
  }

  async function selectAllMatching() {
    setBulkWorking(true);
    try {
      const selection = await client.createFrozenTransactionSelection({
        filter: {
          ...(active.categoryId ? { categoryIds: [active.categoryId] } : {}),
          ...(active.tagNames
            ? {
                tagNames: active.tagNames
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(active.q ? { q: active.q } : {}),
          ...(active.accountId ? { accountIds: [active.accountId] } : {}),
          ...(active.direction ? { directions: [active.direction] } : {}),
          ...(active.dateFrom ? { dateFrom: active.dateFrom } : {}),
          ...(active.dateTo ? { dateTo: active.dateTo } : {}),
        },
      });
      setFrozenSelectionId(selection.id);
      setSelectedIds(new Set());
      setBulkMessage(`${selection.count} matching rows frozen.`);
    } catch {
      setBulkMessage("Could not select matching transactions. Try again.");
    } finally {
      setBulkWorking(false);
    }
  }

  async function saveView() {
    if (!viewName.trim()) return;
    try {
      await client.createTransactionView({
        name: viewName.trim(),
        definition: {
          filters: {
            ...(filters.categoryId ? { categoryIds: [filters.categoryId] } : {}),
            ...(filters.tagNames
              ? {
                  tagNames: filters.tagNames
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                }
              : {}),
            q: filters.q,
            ...(filters.accountId ? { accountIds: [filters.accountId] } : {}),
            ...(filters.direction ? { directions: [filters.direction] } : {}),
            ...(filters.dateFrom ? { dateFrom: filters.dateFrom } : {}),
            ...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
          },
          sort: filters.sort,
          visibleColumns,
        },
      });
      setViewName("");
      await queryClient.invalidateQueries({ queryKey: ["transaction-views"] });
      setBulkMessage("View saved.");
    } catch {
      setBulkMessage("Could not save this view. Try again.");
    }
  }

  return (
    <section
      className="finance-controls"
      aria-labelledby="transactions-heading"
      style={{ display: "grid", gap: 12 }}
    >
      <h1 id="transactions-heading" style={{ margin: 0, fontSize: 24 }}>
        Transactions
      </h1>
      <div>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            setRecording((open) => !open);
          }}
        >
          Record cash transaction
        </Button>
      </div>
      {recording ? (
        <ManualTransactionForm
          accounts={accountsQuery.data?.items ?? []}
          onRecorded={() => {
            setRecording(false);
            void queryClient.invalidateQueries({ queryKey: ["transactions"] });
          }}
          onCancel={() => {
            setRecording(false);
          }}
        />
      ) : null}
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
          From{" "}
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(event) => {
              setFilters({ ...filters, dateFrom: event.target.value });
            }}
          />
        </label>
        <label>
          To{" "}
          <input
            type="date"
            value={filters.dateTo}
            onChange={(event) => {
              setFilters({ ...filters, dateTo: event.target.value });
            }}
          />
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
        <label>
          Category filter
          <select
            value={filters.categoryId}
            onChange={(e) => {
              setFilters({ ...filters, categoryId: e.target.value });
            }}
          >
            <option value="">All categories</option>
            {(categoriesQuery.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tags filter
          <input
            value={filters.tagNames}
            onChange={(e) => {
              setFilters({ ...filters, tagNames: e.target.value });
            }}
            placeholder="Comma-separated exact tag names"
          />
        </label>
      </form>

      <fieldset>
        <legend>Columns</legend>
        {ALL_COLUMNS.map((column) => (
          <label key={column}>
            <input
              type="checkbox"
              checked={visibleColumns.includes(column)}
              disabled={visibleColumns.length === 1 && visibleColumns.includes(column)}
              onChange={() => {
                setVisibleColumns((current) =>
                  current.includes(column)
                    ? current.filter((item) => item !== column)
                    : [...current, column],
                );
              }}
            />{" "}
            {column}
          </label>
        ))}
      </fieldset>
      <label>
        Save view{" "}
        <input
          value={viewName}
          onChange={(event) => {
            setViewName(event.target.value);
          }}
        />
      </label>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={() => void saveView()}
        disabled={!viewName.trim()}
      >
        Save view
      </Button>
      <label>
        Saved views{" "}
        <select
          value={savedViewId}
          onChange={(event) => {
            const id = event.target.value;
            setSavedViewId(id);
            const view = viewsQuery.data?.items.find((item) => item.id === id);
            if (view) {
              setFilters((current) => ({
                ...current,
                q: view.definition.filters.q ?? "",
                categoryId: view.definition.filters.categoryIds?.[0] ?? "",
                tagNames: view.definition.filters.tagNames?.join(", ") ?? "",
                accountId: view.definition.filters.accountIds?.[0] ?? "",
                direction: view.definition.filters.directions?.[0] ?? "",
                dateFrom: view.definition.filters.dateFrom ?? "",
                dateTo: view.definition.filters.dateTo ?? "",
                sort: view.definition.sort,
              }));
              setVisibleColumns(view.definition.visibleColumns);
            }
          }}
        >
          <option value="">Choose a view</option>
          {(viewsQuery.data?.items ?? []).map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
            </option>
          ))}
        </select>
      </label>

      {rows.length > 0 ? (
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={bulkWorking}
          onClick={() => void selectAllMatching()}
        >
          Select all matching results
        </Button>
      ) : null}
      {selectedIds.size > 0 || frozenSelectionId ? (
        <div aria-live="polite">
          {frozenSelectionId ? "All matching rows selected" : `${selectedIds.size} selected`}
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={bulkWorking}
            onClick={() => {
              setSelectedIds(new Set());
              setFrozenSelectionId(null);
              setBulkMessage("");
            }}
          >
            Clear selection
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={bulkWorking}
            onClick={() =>
              void runBulk("transactions.excludeFromAnalyticsBulk", { excluded: true })
            }
          >
            {bulkWorking ? "Working…" : "Exclude selected from analytics"}
          </Button>
          <label>
            Tags{" "}
            <input
              value={bulkTags}
              onChange={(event) => {
                setBulkTags(event.target.value);
              }}
              placeholder="Food, travel"
            />
          </label>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={bulkWorking || !bulkTags.trim()}
            onClick={() =>
              void runBulk("transactions.addTagsBulk", {
                tags: bulkTags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              })
            }
          >
            Add tags
          </Button>
          <label>
            Category{" "}
            <select
              value={bulkCategoryId}
              onChange={(event) => {
                setBulkCategoryId(event.target.value);
              }}
            >
              <option value="">Uncategorized</option>
              {(categoriesQuery.data?.items ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={bulkWorking}
            onClick={() =>
              void runBulk("transactions.setCategoryBulk", { categoryId: bulkCategoryId || null })
            }
          >
            Set category
          </Button>
        </div>
      ) : null}
      {bulkMessage ? <p role="status">{bulkMessage}</p> : null}

      {search.isPending ? (
        <div aria-label="Loading transactions" style={{ display: "grid", gap: 8 }}>
          <Skeleton style={{ height: 44 }} />
          <Skeleton style={{ height: 44 }} />
          <Skeleton style={{ height: 44 }} />
        </div>
      ) : search.isError ? (
        <div role="alert">
          <p>Could not load transactions.</p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              void search.refetch();
            }}
          >
            Retry
          </Button>
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
              selectedIds={selectedIds}
              onToggle={(transactionId) => {
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (next.has(transactionId)) next.delete(transactionId);
                  else next.add(transactionId);
                  return next;
                });
              }}
              visibleColumns={visibleColumns}
            />
          </div>
          {selectedId ? (
            <TransactionDetailDrawer
              transactionId={selectedId}
              onClose={() => {
                const url = new URL(window.location.href);
                url.searchParams.delete("transactionId");
                window.history.replaceState(null, "", `${url.pathname}${url.search}`);
                setSelectedId(null);
              }}
            />
          ) : null}
          {search.hasNextPage ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={search.isFetchingNextPage}
              onClick={() => {
                void search.fetchNextPage();
              }}
            >
              {search.isFetchingNextPage ? "Loading more…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
