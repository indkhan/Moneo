import Link from "next/link";
import * as React from "react";

type EvidenceRow = { id: string; accountId?: string };
type EvidenceData = {
  toolName: string;
  input: Record<string, unknown>;
  output: {
    result?: unknown;
    evidence?: {
      rows: EvidenceRow[];
      dataCutoff: string;
      calculationMetadata: { filters: Record<string, unknown> };
    };
  };
};

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <>—</>;
  if (typeof value === "string" || typeof value === "number") return <>{String(value)}</>;
  return (
    <>
      {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
        <span key={key} style={{ marginRight: 12 }}>
          <strong>{key}:</strong>{" "}
          {typeof item === "string" || typeof item === "number" || typeof item === "boolean"
            ? String(item)
            : JSON.stringify(item)}
        </span>
      ))}
    </>
  );
}

export function EvidenceView({ evidence }: { evidence: EvidenceData }) {
  const filters = evidence.output.evidence?.calculationMetadata.filters ?? evidence.input;
  const cutoff = evidence.output.evidence?.dataCutoff;
  const rows = evidence.output.evidence?.rows ?? [];
  return (
    <section aria-labelledby="evidence-heading" style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 id="evidence-heading" style={{ margin: 0 }}>
          Evidence
        </h1>
        <p style={{ color: "var(--moneo-muted)" }}>Calculated with {evidence.toolName}</p>
      </div>
      <dl style={{ margin: 0, display: "grid", gap: 8 }}>
        <div>
          <dt>Filters</dt>
          <dd>
            <Value value={filters} />
          </dd>
        </div>
        <div>
          <dt>Data cutoff</dt>
          <dd>
            <Value value={cutoff} />
          </dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>
            <Value value={evidence.output.result} />
          </dd>
        </div>
      </dl>
      <div>
        <h2>Contributing transactions</h2>
        {rows.length ? (
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <Link href={`/money/transactions?transactionId=${encodeURIComponent(row.id)}`}>
                  View transaction {row.id}
                </Link>
                {row.accountId ? ` · Account ${row.accountId}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p>No individual transactions were returned for this result.</p>
        )}
      </div>
    </section>
  );
}
