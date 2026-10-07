import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewVerification } from "./review-verification";
it("discloses legacy reviews without changing their original evidence", () => {
  const evidence = { period: { from: "2026-09-01" } };
  expect(renderToStaticMarkup(<ReviewVerification evidence={evidence} />)).toContain("Unverified historical review");
  expect(evidence).toEqual({ period: { from: "2026-09-01" } });
  expect(renderToStaticMarkup(<ReviewVerification evidence={{ verification: { version: 1, method: "structured-evidence-v1", receiptIds: ["retained"] } }} />)).toContain("checked against retained calculation evidence");
});
