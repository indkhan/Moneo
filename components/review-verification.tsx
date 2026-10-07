export function ReviewVerification({ evidence }: { evidence: unknown }) {
  const verification = evidence && typeof evidence === "object" && "verification" in evidence ? evidence.verification : null;
  const verified = verification && typeof verification === "object" && "version" in verification && verification.version === 1
    && "method" in verification && verification.method === "structured-evidence-v1"
    && "receiptIds" in verification && Array.isArray(verification.receiptIds) && verification.receiptIds.length > 0;
  return <p role="status" className="mt-3 text-sm text-muted-foreground">{verified
    ? "Measured claims were checked against retained calculation evidence. Interpretation is labelled separately."
    : "Unverified historical review: these original AI statements predate evidence validation. Check the saved records before relying on them."}</p>;
}
