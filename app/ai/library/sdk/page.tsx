import Link from "next/link";
import { ALLOWED_SDK_BY_KIND, CALCULATOR_RUNTIME, FORBIDDEN_SOURCE_MESSAGES, MAX_SOURCE_CHARS } from "@/lib/artifacts/spec";
import { SNAPSHOT_LIMITS } from "@/lib/artifacts/coverage";

export const metadata = { title: "Artifact SDK reference" };

const contract = `// Your source is ONE pure function expression. It runs in QuickJS with no
// DOM, network, timers or module loading, and receives only host JSON.
(input: CalculatorInput) => CalculatorOutput

type CalculatorInput = {
  snapshot: Snapshot;                         // host-built, read-only evidence
  params: Record<string, number | string>;   // validated manifest params
};

// Money is ALWAYS decimal integer text in minor units ("12345" = 123.45 EUR).
// Use BigInt for arithmetic and return results as strings.
type Minor = string;`;

const snapshot = `// Custom kinds (custom_report, custom_tracker, custom_planner, custom_comparison)
// receive only the operations declared in manifest.sdk.
type Snapshot = {
  currency: string;                 // workspace display currency ("" when nothing loaded)
  unavailable?: string;             // why some declared evidence is missing
  partial?: boolean;                // unreviewed classifications excluded
  spending?: Period;                // "spending" operation
  cashflow?: Period;                // "cashflow" operation (same shape)
  balances?: Balance[];             // "balances", at most ${SNAPSHOT_LIMITS.balances}
  goals?: Goal[];                   // "goals", at most ${SNAPSHOT_LIMITS.goals}
  forecast?: TripForecast;          // "forecast"
  investigation?: Investigation;    // when manifest.investigation is set
  coverage?: { balances?: Cover; goals?: Cover };
};

type Period = {
  currency: string; from: string; to: string;          // ISO dates of the evidence month
  incomeMinor: Minor; spendingMinor: Minor; netMinor: Minor;
  daily: { date: string; spendingMinor: Minor }[];
  byAccount: { id: string; incomeMinor: Minor; spendingMinor: Minor; netMinor: Minor; partial: boolean }[];
  partial: boolean; excludedReviewRows: number;
  unavailable?: string;                                 // e.g. missing FX conversion
};

type Balance = { id: string; name: string; currency_code: string;
  balance: { amount_minor: Minor | null; as_of: string | null; status: "current" | "stale" | "missing" | "ambiguous" } };

type Goal = { id: string; name: string; currency: string; targetMinor: Minor;
  savedMinor: Minor | null; savedAsOf: string | null;     // recorded savings (null = unknown)
  reservedMinor: Minor; remainingMinor: Minor | null;     // reservations are virtual earmarks
  plannedMonthlyMinor: Minor; contributionStartsOn: string | null };

type TripForecast = { currency: string; baselineAvailableMinor: Minor | null;
  withTripAvailableMinor: Minor | null; evaluatedCostMinor: Minor; tripDate: string;
  limitingDate?: string | null; afterTripMinor?: Minor | null; unavailable?: string | null };

type Investigation = {                 // deterministic host query results
  interpretedFilters: { period: { from: string; to: string }; groupBy: string[] };
  groups: { key: string; dimensions: Record<string, unknown>; currency: string;
    currentMinor: Minor | null; comparisonMinor: Minor | null; deltaMinor: Minor | null; currentCount: number }[];
  records: { total: number; items: { id: string; date: string; description: string; merchantId: string | null }[] };
  coverage: { partial: boolean };      // never sum paginated records; use groups
};

type Cover = { total: number; included: number; truncated: boolean };`;

const output = `type CalculatorOutput = {      // include at least one key
  summary?: string;                 // headline, max 500 characters
  numbers?: Record<string, string | number>;   // stat tiles; keys ending in "Minor" render as money
  rows?: Record<string, unknown>[];            // table, max 50 rows
  chart?: { labels: string[]; values: number[];   // equal lengths, finite numbers
            type?: "bar" | "line"; label?: string };
  warning?: string;                 // shown as a note
  unavailable?: string;             // return this instead of throwing on missing data
};`;

const manifest = `{
  "kind": "custom_tracker",               // must match the tool's kind
  "runtime": "${CALCULATOR_RUNTIME}",
  "sdk": ["spending"],                    // subset of the kind's operations
  "params": {
    "monthlyBudgetMinor": { "type": "number", "default": 150000, "min": 0, "label": "Monthly budget" },
    "month": { "type": "string", "default": "2026-09", "maxLength": 7 }   // YYYY-MM selects evidence month
  },
  "renderer": "trusted"
}`;

const example = `(input) => {
  const p = input.snapshot.spending;
  if (!p || p.unavailable) return { unavailable: (p && p.unavailable) || "No spending evidence" };
  const budget = BigInt(input.params.monthlyBudgetMinor);
  const spent = BigInt(p.spendingMinor);
  return {
    summary: spent > budget ? "Over budget" : "Within budget",
    numbers: { spentMinor: String(spent), remainingMinor: String(budget - spent) },
  };
}`;

function Code({ children }: { children: string }) {
  return <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted p-4 font-mono text-xs leading-relaxed text-foreground">{children}</pre>;
}

const sections = [["contract", "Contract"], ["manifest", "Manifest"], ["snapshot", "Snapshot types"], ["operations", "Operations by kind"], ["output", "Output"], ["limits", "Limits and sandbox"], ["example", "Example"]] as const;

export default function SdkReference() {
  return <main className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground"><Link href="/ai/library" className="hover:text-foreground hover:underline">Library</Link> <span aria-hidden>/</span> SDK reference</nav>
    <h1 className="mt-2 text-3xl font-semibold tracking-tight">Finance SDK reference</h1>
    <p className="mt-2 max-w-3xl text-muted-foreground">Calculators are pure functions. The host reads your data through approved operations, builds a JSON snapshot and runs your code in an isolated QuickJS sandbox. Your code never touches the database, network or page. Financial truth stays in host evidence, so read amounts from the snapshot and never guess them.</p>
    <div className="mt-8 grid gap-10 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <nav aria-label="On this page" className="hidden lg:block"><ul className="sticky top-6 space-y-1 text-sm">{sections.map(([id, label]) => <li key={id}><a href={`#${id}`} className="text-muted-foreground hover:text-foreground">{label}</a></li>)}</ul></nav>
      <div className="min-w-0 space-y-10">
        <section id="contract"><h2 className="text-xl font-semibold">Contract</h2><Code>{contract}</Code></section>
        <section id="manifest"><h2 className="text-xl font-semibold">Manifest</h2>
          <p className="mt-2 text-sm text-muted-foreground">Declares the operations the calculator reads and the inputs people can change. Params named <code>…Minor</code> must be exact integers. A manifest <code>investigation</code> runs a deterministic host query; it needs a declared spending or cashflow operation.</p>
          <Code>{manifest}</Code></section>
        <section id="snapshot"><h2 className="text-xl font-semibold">Snapshot types</h2><Code>{snapshot}</Code>
          <p className="mt-2 text-sm text-muted-foreground">Built-in kinds use legacy flat snapshots: <code>spending_explorer</code> receives a <code>Period</code>; <code>trip_planner</code> a <code>TripForecast</code>; <code>goal_tracker</code> <code>{"{ currency, goals }"}</code>.</p></section>
        <section id="operations"><h2 className="text-xl font-semibold">Operations by kind</h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted text-muted-foreground"><tr><th className="px-3 py-2 font-medium">Kind</th><th className="px-3 py-2 font-medium">Allowed operations</th></tr></thead>
            <tbody>{Object.entries(ALLOWED_SDK_BY_KIND).map(([kind, operations]) => <tr key={kind} className="border-t border-border"><td className="px-3 py-2 font-mono text-xs">{kind}</td><td className="px-3 py-2">{operations.join(", ")}</td></tr>)}</tbody></table></div>
          <p className="mt-2 text-sm text-muted-foreground">Each operation also needs the matching AI data access in Settings. Evidence that is denied or missing arrives as <code>unavailable</code>.</p></section>
        <section id="output"><h2 className="text-xl font-semibold">Output</h2><Code>{output}</Code>
          <p className="mt-2 text-sm text-muted-foreground">The host renders the output with app styling. Your code cannot produce HTML, and markup in strings shows as plain text.</p></section>
        <section id="limits"><h2 className="text-xl font-semibold">Limits and sandbox</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            <li>Source up to {MAX_SOURCE_CHARS.toLocaleString("en")} characters; must be a single function expression.</li>
            <li>QuickJS: 16 MB memory, 256 KB stack, 500 ms execution; the Web Worker is stopped after 5 s.</li>
            <li>Output up to 20,000 characters of JSON, nesting depth 4, 50 items per array, 30 keys per object.</li>
            <li>Every save is validated on the server against synthetic fixtures, including missing data, very large amounts, foreign currencies and capped inputs. A failed candidate is recorded and never replaces the active version.</li>
            <li>Versions are append-only. Saves name the version they edited, so concurrent edits are detected and nothing is silently overwritten.</li>
          </ul>
          <h3 className="mt-5 font-medium">Rejected before running</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">{FORBIDDEN_SOURCE_MESSAGES.map(message => <li key={message} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{message}</li>)}</ul></section>
        <section id="example"><h2 className="text-xl font-semibold">Example</h2><Code>{example}</Code></section>
      </div>
    </div>
  </main>;
}
