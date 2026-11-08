import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SafeForm } from "./safe-form";

it("never submits as a plain GET before the page hydrates", () => {
  // Without an action, a click before hydration navigates to ?id=… and saves nothing.
  const html = renderToStaticMarkup(<SafeForm action={async () => ({})}><input name="id" defaultValue="card" /><button>Add to Home</button></SafeForm>);
  expect(html).toMatch(/<form[^>]*\saction="/);
});
