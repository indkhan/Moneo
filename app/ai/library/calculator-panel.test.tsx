import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { calculatorManifestSchema } from "@/lib/artifacts/spec";
import { CalculatorPanel } from "./calculator-panel";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./actions", () => ({ saveCalculatorParams: vi.fn() }));
vi.mock("@/lib/artifacts/run", () => ({ runIsolatedArtifact: vi.fn() }));

it("discloses host input coverage independently of generated output", () => {
  const html = renderToStaticMarkup(<CalculatorPanel source="input => ({summary:'ok'})" snapshot={{currency: "EUR", coverage: {balances: {total: 51, included: 50, truncated: true}, goals: {total: 20, included: 20, truncated: false}}}} initialParams={{}} manifest={calculatorManifestSchema.parse({kind:"custom_report",runtime:"quickjs-calculator-v1",sdk:[],params:{}})} versionLabel="v1" artifactId="synthetic" />);
  expect(html).toContain("50 of 51 balances");
  expect(html).toContain("Remaining records are excluded");
  expect(html).not.toContain("20 of 20 goals");
});

it("shows the trusted host evidence failure even if generated code returns a generic message", () => {
  const reason = "cashflow: AI access to transactions is disabled in Settings";
  const html = renderToStaticMarkup(<CalculatorPanel source="input => ({ unavailable: 'No cashflow' })" snapshot={{ currency: "EUR", unavailable: reason }} initialParams={{}} manifest={calculatorManifestSchema.parse({kind:"custom_report",runtime:"quickjs-calculator-v1",sdk:[],params:{}})} versionLabel="v1" artifactId="test" />);
  expect(html).toContain(reason);
  expect(html).toContain('role="alert"');
});
