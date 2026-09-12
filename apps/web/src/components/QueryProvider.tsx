"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * Issue 4.7 — shared react-query client for the Money section.
 *
 * Scoped to `/money` (see `app/money/layout.tsx`) so finance list caching
 * never leaks into unrelated sections. Modest stale time keeps back/forward
 * navigation instant; every mutation path (Issues 4.10/4.12, Epoch 5)
 * invalidates `["accounts"]` / `["transactions"]` explicitly.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
