"use client";
import { useEffect, useRef, useState } from "react";
import * as React from "react";
import Link from "next/link";
import { naturalTransactionFilters } from "../lib/command-search";
const COMMANDS = [
  ["Home", "/home"],
  ["Money", "/money"],
  ["Transactions", "/money/transactions"],
  ["Accounts", "/money/accounts"],
  ["Import a statement", "/money/import"],
  ["Plan", "/plan"],
  ["AI chat", "/ai"],
  ["Settings", "/settings"],
] as const;
export function CommandPalette() {
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<Array<{ id: string; description: string }>>([]),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null);
  const open = () => {
    dialog.current?.showModal();
    input.current?.focus();
  };
  const close = () => {
    dialog.current?.close();
    trigger.current?.focus();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    setResults([]);
    setError("");
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const filters = naturalTransactionFilters(query);
      void fetch(`/api/v1/transactions/search?${new URLSearchParams({ ...filters, limit: "5" })}`, {
        signal: controller.signal,
      })
        .then(async (r) => {
          if (!r.ok) throw new Error("Sign in and complete security setup to search transactions.");
          const body = (await r.json()) as { items?: Array<{ id: string; description: string }> };
          setResults(body.items ?? []);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted)
            setError(e instanceof Error ? e.message : "Search unavailable");
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const matches = COMMANDS.filter(([label]) => label.toLowerCase().includes(query.toLowerCase())),
    filters = naturalTransactionFilters(query);
  return (
    <>
      <button ref={trigger} type="button" aria-label="Open command search" onClick={open}>
        Search or run a command <kbd>Ctrl K</kbd>
      </button>
      <dialog
        ref={dialog}
        aria-label="Command search"
        onClose={() => trigger.current?.focus()}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
        style={{
          width: "min(560px, 85vw)",
          padding: 20,
          background: "var(--moneo-surface)",
          color: "inherit",
          border: "1px solid var(--moneo-border)",
          borderRadius: 8,
        }}
      >
        <label htmlFor="command-search">Search navigation and commands</label>
        <input
          ref={input}
          id="command-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          placeholder="Try: restaurants last month"
          style={{ display: "block", boxSizing: "border-box", width: "100%", margin: "8px 0" }}
        />
        <nav aria-label="Search results" style={{ display: "grid", gap: 8 }}>
          {matches.map(([label, href]) => (
            <Link key={href} href={href} onClick={close}>
              {label}
            </Link>
          ))}
          {query.trim() && (
            <>
              <p>
                Transaction filters:{" "}
                {Object.entries(filters)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" � ")}
              </p>
              <Link href={`/money/transactions?${new URLSearchParams(filters)}`} onClick={close}>
                Apply these transaction filters
              </Link>
              {results.map((row) => (
                <Link
                  key={row.id}
                  href={`/money/transactions?transactionId=${encodeURIComponent(row.id)}`}
                  onClick={close}
                >
                  {row.description}
                </Link>
              ))}
            </>
          )}
        </nav>
        {error && <p role="status">{error}</p>}
        <button type="button" onClick={close} style={{ marginTop: 16 }}>
          Close
        </button>
      </dialog>
    </>
  );
}
