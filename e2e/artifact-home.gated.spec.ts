import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());

// The artifact is saved directly, as the builder would, so no AI provider is called.
const HTML = `<!doctype html><html><head></head><body><p id="view"></p><p>Accounts: <b id="count">…</b></p>
<script>view.textContent = "View: " + window.MONEO_VIEW; count.textContent = String((window.MONEO_DATA.accounts || []).length);</script></body></html>`;

test("an artifact previews in the gallery, pins to Home as a widget and is deleted from the gallery", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `Artifact QA ${randomUUID().slice(0, 8)}`;
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const [layout] = await db`select items from public.dashboard_layouts where workspace_id = ${workspaceId}`;
  const [{ id }] = await db`insert into public.artifacts (workspace_id, title) values (${workspaceId}, ${title}) returning id`;
  try {
    await db`insert into public.artifact_versions (workspace_id, artifact_id, version, prompt, html, queries)
      values (${workspaceId}, ${id}, 1, 'Count my accounts', ${HTML}, ${db.json([{ name: "accounts", source: "accounts", input: {} }])})`;

    // Gallery: a live preview and the original request on the card.
    await page.goto("/ai/artifacts");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: title, exact: true }) });
    await expect(card).toContainText("Count my accounts");
    await expect(card.frameLocator("iframe").getByText("View: page")).toBeVisible({ timeout: 30_000 });

    // Pin from the viewer; Home renders the compact widget view.
    await card.getByRole("link", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Add to Home" }).click();
    await expect(page.getByRole("button", { name: "On Home" })).toHaveAttribute("aria-pressed", "true");
    await page.goto("/");
    const widget = page.getByRole("region", { name: title, exact: true });
    await expect(widget.frameLocator("iframe").getByText("View: widget")).toBeVisible({ timeout: 30_000 });
    await expect(widget.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/ai/artifacts/${id}`);

    // Cancelling the confirmation keeps it; accepting deletes it and it leaves Home.
    await page.goto("/ai/artifacts");
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: `Delete ${title}` }).click();
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: `Delete ${title}` }).click();
    await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0, { timeout: 30_000 });
    const [deleted] = await db`select deleted_at from public.artifacts where id = ${id}`;
    expect(deleted.deleted_at).not.toBeNull();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: title, exact: true })).toHaveCount(0);
  } finally {
    // Restore the QA workspace: its previous Home layout and no test artifact.
    if (layout) await db`update public.dashboard_layouts set items = ${layout.items}, version = version + 1 where workspace_id = ${workspaceId}`;
    else await db`delete from public.dashboard_layouts where workspace_id = ${workspaceId}`;
    await db`delete from public.artifacts where id = ${id}`;
    await db.end();
  }
});
