import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { compileCard } from "../lib/cards/sandbox";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());

// The page and card are saved directly, as the artifact's chat would save them, so no AI provider is called.
const HTML = `<!doctype html><html><head></head><body><p>Accounts: <b id="count">…</b></p>
<script>count.textContent = String((window.MONEO_DATA.accounts || []).length);</script></body></html>`;
const CARD = `export default function Card({ data, params, size }) {
  return <div style={{ display: "grid", gap: 8 }}>
    <Kit.Style css=".big{font-size:32px;font-weight:600}" />
    <p className="big">Accounts {data.accounts.length}</p>
    <p>Picked {params.pick} at {size}</p>
    <Kit.Param name="pick" />
  </div>;
}`;
const PARAMS = [{ kind: "choice", name: "pick", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], default: "a" }];

test("an artifact card previews natively, goes on Home at its size, reacts to its control and leaves with the artifact", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `Artifact QA ${randomUUID().slice(0, 8)}`;
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const [layout] = await db`select items from public.dashboard_layouts where workspace_id = ${workspaceId}`;
  const [{ id }] = await db`insert into public.artifacts (workspace_id, title) values (${workspaceId}, ${title}) returning id`;
  try {
    const queries = db.json([{ name: "accounts", source: "accounts", input: {} }]);
    await db`insert into public.artifact_versions (workspace_id, artifact_id, version, prompt, html, queries) values (${workspaceId}, ${id}, 1, 'Count my accounts', ${HTML}, ${queries})`;
    const [{ id: cardId }] = await db`insert into public.artifact_cards (workspace_id, artifact_id, title) values (${workspaceId}, ${id}, ${`${title} card`}) returning id`;
    await db`insert into public.artifact_card_versions (workspace_id, card_id, version, kind, source, compiled, queries, params, prompt)
      values (${workspaceId}, ${cardId}, 1, 'code', ${CARD}, ${compileCard(CARD)}, ${queries}, ${db.json(PARAMS)}, 'Count my accounts on Home')`;

    // Gallery: a live preview of the page and the original request.
    await page.goto("/ai/artifacts");
    const tile = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: title, exact: true }) });
    await expect(tile).toContainText("Count my accounts");
    await expect(tile.frameLocator("iframe").getByText("Accounts:")).toBeVisible({ timeout: 30_000 });

    // The Home cards tab renders the card in the page itself (no frame), at the chosen size.
    await page.goto(`/ai/artifacts/${id}?tab=cards`);
    const preview = page.getByRole("region", { name: `${title} card`, exact: true });
    await expect(preview.getByText("Picked a at M")).toBeVisible({ timeout: 30_000 });
    await expect(preview.locator("iframe")).toHaveCount(0);
    await page.getByRole("group", { name: "Size" }).getByRole("button", { name: "S" }).click();
    await expect(preview.getByText("Picked a at S")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add to Home" }).click();
    await expect(page.getByRole("button", { name: "Remove from Home" })).toBeVisible({ timeout: 30_000 });

    // Home shows the published card; its control re-renders it with the other value.
    await page.goto("/");
    const card = page.getByRole("region", { name: `${title} card`, exact: true });
    await expect(card.getByText("Picked a at S")).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/ai/artifacts/${id}?tab=cards`);
    await card.getByRole("button", { name: "Beta" }).click();
    await expect(card.getByText("Picked b at S")).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("button", { name: "Beta" })).toHaveAttribute("aria-pressed", "true");

    // Deleting the artifact takes its card off Home.
    await page.goto("/ai/artifacts");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: `Delete ${title}` }).click();
    await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0, { timeout: 30_000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: `${title} card`, exact: true })).toHaveCount(0);
  } finally {
    // Restore the QA workspace: its previous Home layout and no test artifact.
    if (layout) await db`update public.dashboard_layouts set items = ${layout.items}, version = version + 1 where workspace_id = ${workspaceId}`;
    else await db`delete from public.dashboard_layouts where workspace_id = ${workspaceId}`;
    await db`delete from public.artifacts where id = ${id}`;
    await db.end();
  }
});
