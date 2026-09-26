// Shared deterministic fixtures for Moneo Playwright e2e (prompt.md §46).
//
// No live OpenRouter calls: every spec in this directory either drives the UI
// against mocked `/api/*` responses or skips cleanly when real Supabase creds
// are absent. See e2e/README.md for required env and how to enable the gated
// full-journey spec.
import * as fs from "node:fs";

// Minimal two-row statement. Amounts are exact decimal strings; the app owns
// minor-unit conversion, so fixtures never pre-convert.
export const AUGUST_CSV = [
  "date,description,amount",
  "2026-08-01,Salary Acme,2500.00",
  "2026-08-02,AMZN MKTP DE,-42.99",
  "",
].join("\n");

// Overlapping newer file: repeats one August row (dedup candidate) plus new
// September rows. Used by the gated spec to verify re-import safety.
export const SEPTEMBER_CSV = [
  "date,description,amount",
  "2026-08-02,AMZN MKTP DE,-42.99",
  "2026-09-01,Salary Acme,2500.00",
  "2026-09-03,Spotify,-10.99",
  "",
].join("\n");

// Deterministic stand-in for the AI-proposed column mapping
// (POST /api/imports/inspect without a `mapping` field calls OpenRouter in
// production; tests fulfil that request with this payload instead).
export const MOCK_MAPPING = {
  accountName: "Checking",
  currencyCode: "EUR",
  dateColumn: "date",
  descriptionColumn: "description",
  amountColumn: "amount",
  dateFormat: "iso",
  amountSign: "signed",
} as const;

// Canned inspect response shaped exactly like app/api/imports/inspect.
// amountMinor is serialized as a string by the real route.
export function mockInspectResponse(accountName = "Checking") {
  return {
    headers: ["date", "description", "amount"],
    sample: [
      { date: "2026-08-01", description: "Salary Acme", amount: "2500.00" },
      { date: "2026-08-02", description: "AMZN MKTP DE", amount: "-42.99" },
    ],
    mapping: { ...MOCK_MAPPING, accountName },
    preview: {
      accountName,
      currencyCode: "EUR",
      totalRows: 2,
      dateRange: { from: "2026-08-01", to: "2026-08-02" },
      examples: [
        {
          postedOn: "2026-08-01",
          description: "Salary Acme",
          amountMinor: "250000",
          currencyCode: "EUR",
        },
        {
          postedOn: "2026-08-02",
          description: "AMZN MKTP DE",
          amountMinor: "-4299",
          currencyCode: "EUR",
        },
      ],
    },
  };
}

export function mockCompletedImport(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "import-1",
    filename: "august.csv",
    status: "completed",
    total_rows: 2,
    new_rows: 2,
    matched_rows: 0,
    review_rows: 0,
    rejected_rows: 0,
    error: null,
    created_at: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

export function hasSupabaseEnv(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

// Full-journey auth uses a pre-authenticated Playwright storageState file
// (Supabase magic-link OTP has no deterministic inbox in CI). The gated spec
// skips unless this file exists; see e2e/README.md §2 for creation steps.
export function e2eStorageStatePath(): string | null {
  const candidate = process.env.E2E_STORAGE_STATE;
  if (candidate && fs.existsSync(candidate)) return candidate;
  const fallback = "e2e/.auth.json";
  return fs.existsSync(fallback) ? fallback : null;
}

export function gatedSkipReason(): string {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL)
    missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!e2eStorageStatePath())
    missing.push("E2E_STORAGE_STATE (or e2e/.auth.json storageState)");
  return (
    `Skipped: full authenticated Supabase journey needs ${missing.join(", ")}. ` +
    `This is a SKIP, not a pass — see e2e/README.md §2. ` +
    `Credential-free specs (smoke + mocked import journey) still run.`
  );
}
