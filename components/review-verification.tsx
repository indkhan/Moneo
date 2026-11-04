import Link from "next/link";

export function ReviewVerification({ evidence, from }: { evidence: unknown; from?: string }) {
  const verification = evidence && typeof evidence === "object" && "verification" in evidence ? evidence.verification : null;
  const verified = verification && typeof verification === "object" && "version" in verification && verification.version === 1
    && "method" in verification && verification.method === "structured-evidence-v1"
    && "receiptIds" in verification && Array.isArray(verification.receiptIds) && verification.receiptIds.length > 0;
  const receipts = verified ? [...new Set(verification.receiptIds as string[])] : [];
  return <div className="mt-3 text-sm text-muted-foreground"><p role="status">{verified
    ? "Measured claims were checked against retained calculation evidence. Interpretation is labelled separately."
    : "Unverified historical review: these original AI statements predate evidence validation. Check the saved records before relying on them."}</p>
    {receipts.length > 0 && <p className="mt-1">Check the evidence: {receipts.map((id, index) => <span key={id}>{index > 0 && ", "}<Link className="underline" href={`/ai/evidence/${id}${from ? `?${new URLSearchParams({ from })}` : ""}`}>record {index + 1}</Link></span>)}</p>}
  </div>;
}
