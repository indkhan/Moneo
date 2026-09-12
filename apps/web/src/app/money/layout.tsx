import type { ReactNode } from "react";
import { QueryProvider } from "@/components/QueryProvider";

/**
 * Issue 4.7 — react-query scope for the Money section. Finance list
 * caching lives and dies here, never in unrelated sections.
 */
export default function MoneyLayout({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
