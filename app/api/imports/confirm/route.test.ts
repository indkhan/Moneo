import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { start } from "workflow/api";

const fixture = vi.hoisted(() => ({
  imports: [] as { id: string; status: string }[], inserts: [] as Record<string, unknown>[], race: false,
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/import-file", () => ({ importFile: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({
  workspace: { id: "workspace" },
  supabase: {
    storage: { from: () => ({ upload: async () => ({ error: { message: "The resource already exists" } }) }) },
    from: () => {
      let excludedStatus: string | undefined;
      let insertion: Record<string, unknown> | undefined;
      const result = () => ({ data: fixture.imports.find(item => item.status !== excludedStatus) ?? null, error: null });
      const query = {
        select: () => query, eq: () => query,
        neq: (_column: string, value: string) => { excludedStatus = value; return query; },
        insert: (value: Record<string, unknown>) => { insertion = value; fixture.inserts.push(value); return query; },
        maybeSingle: async () => result(),
        single: async () => {
          if (!insertion) return result();
          if (fixture.race) {
            fixture.imports.push({ id: "concurrent-import", status: "queued" });
            return { data: null, error: { code: "23505", message: "duplicate active file" } };
          }
          fixture.imports.push({ id: "new-import", status: String(insertion.status) });
          return { data: { id: "new-import" }, error: null };
        },
      };
      return query;
    },
  },
}) }));

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  fixture.imports = [{ id: "old-import", status: "undone" }];
  fixture.inserts = [];
  fixture.race = false;
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function request() {
  const form = new FormData();
  form.set("file", new File(["Date,Description,Amount\n2026-10-01,Coffee,-2.00"], "synthetic.csv"));
  form.set("mapping", JSON.stringify({ accountName: "Checking", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot" }));
  return new Request("http://localhost/api/imports/confirm", { method: "POST", body: form });
}

it("starts a fresh import of undone bytes without changing historical evidence", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ importId: "new-import", status: "queued" });
  expect(fixture.imports[0]).toEqual({ id: "old-import", status: "undone" });
  expect(fixture.inserts).toHaveLength(1);
  expect(start).toHaveBeenCalledOnce();
  expect(fixture.inserts[0].mapping).toMatchObject({ numericConvention: "decimal-dot", parserVersion: "numeric-convention-v2" });
});

it("refuses an unreviewed numeric convention before storage or workflow effects", async () => {
  const form = await request().formData();
  const mapping = JSON.parse(String(form.get("mapping")));
  delete mapping.numericConvention;
  form.set("mapping", JSON.stringify(mapping));
  const response = await POST(new Request("http://localhost/api/imports/confirm", { method: "POST", body: form }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("numeric convention") });
  expect(fixture.inserts).toHaveLength(0);
  expect(start).not.toHaveBeenCalled();
});

it("rejects worker-incompatible descriptions without launching or creating an import", async () => {
  const form = await request().formData();
  form.set("file", new File([`Date,Description,Amount\n2026-10-01,${"x".repeat(501)},1`], "synthetic.csv"));
  const response = await POST(new Request("http://localhost/api/imports/confirm", { method: "POST", body: form }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("500") });
  expect(fixture.inserts).toHaveLength(0);
  expect(start).not.toHaveBeenCalled();
});

it("rejects NUL source evidence before effects even when corrected or excluded", async () => {
  for (const decision of [{ rowNumber: 3, action: "correct", values: { Description: "Corrected" } }, { rowNumber: 3, action: "exclude", reason: "Incompatible evidence" }]) {
    const form = await request().formData();
    form.set("file", new File(["Date,Description,Amount\n2026-10-01,Valid neighbor,1\n2026-10-02,A\0B,2"], "synthetic.csv"));
    form.set("mapping", JSON.stringify({ ...JSON.parse(String(form.get("mapping"))), rowDecisions: [decision] }));
    const response = await POST(new Request("http://localhost/api/imports/confirm", { method: "POST", body: form }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("NUL") });
    expect(fixture.inserts).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  }
});

it("persists reviewed correction/exclusion decisions while retaining the full source row count", async () => {
  const form = await request().formData();
  form.set("file", new File(["Date,Description,Amount\n2026-10-01,First,1\nbad,Second,2\n,Footer,3"], "synthetic.csv"));
  const rowDecisions = [{ rowNumber: 3, action: "correct", values: { Date: "2026-10-02" } }, { rowNumber: 4, action: "exclude", reason: "Statement footer" }];
  form.set("mapping", JSON.stringify({ ...JSON.parse(String(form.get("mapping"))), rowDecisions }));
  const response = await POST(new Request("http://localhost/api/imports/confirm", { method: "POST", body: form }));
  expect(response.status).toBe(200);
  expect(fixture.inserts[0]).toMatchObject({ total_rows: 3, mapping: { rowContractVersion: "normalized-row-v1", rowDecisions } });
  expect(start).toHaveBeenCalledWith(expect.anything(), ["new-import", "workspace", 3, 1]);
});

it("deduplicates active bytes even when an older undone import exists", async () => {
  fixture.imports.push({ id: "active-import", status: "completed" });
  expect(await (await POST(request())).json()).toEqual({ importId: "active-import", status: "completed" });
  expect(fixture.inserts).toHaveLength(0);
  expect(start).not.toHaveBeenCalled();
});

it("returns the concurrent active import rather than an undone historical import", async () => {
  fixture.race = true;
  expect(await (await POST(request())).json()).toEqual({ importId: "concurrent-import", status: "queued" });
  expect(start).not.toHaveBeenCalled();
});
