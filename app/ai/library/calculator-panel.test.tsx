import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalculatorPanel } from "./calculator-panel";

vi.mock("./actions", () => ({ saveCalculatorParams: vi.fn() }));

it("shows the trusted host evidence failure even if generated code returns a generic message", () => {
  const reason = "cashflow: AI access to transactions is disabled in Settings";
  const html = renderToStaticMarkup(<CalculatorPanel source="input => ({ unavailable: 'No cashflow' })" snapshot={{ currency: "EUR", unavailable: reason }} initialParams={{}} versionLabel="v1" artifactId="test" />);
  expect(html).toContain(reason);
  expect(html).toContain('role="alert"');
});
