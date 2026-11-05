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

test("an artifact keeps its older messages accessible after reopening", async ({ page }) => {
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const [{ id }] = await db`insert into public.artifacts (workspace_id, title) values (${workspaceId}, 'Artifact history QA') returning id`;
  const [{ id: conversationId }] = await db`insert into public.conversations (workspace_id, artifact_id, title) values (${workspaceId}, ${id}, 'Artifact history QA') returning id`;
  try {
    for (let index = 0; index < 65; index++) await db`insert into public.messages (workspace_id, conversation_id, role, content, created_at) values (${workspaceId}, ${conversationId}, 'user', ${`History message ${index}`}, ${new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()})`;
    await page.goto(`/ai/artifacts/${id}`);
    await page.reload();
    await expect(page.getByText('History message 0', { exact: true })).toHaveCount(0);
    await expect(page.getByText('History message 64', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await expect(page.getByText('History message 5', { exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await expect(page.getByText('History message 0', { exact: true })).toBeAttached();
    await expect(page.getByRole('button', { name: 'Older messages', exact: true })).toHaveCount(0);
    await expect(page.getByText('History message 64', { exact: true })).toHaveCount(1);
  } finally {
    await db`delete from public.messages where conversation_id = ${conversationId}`;
    await db`delete from public.artifacts where id = ${id}`;
    await db.end();
  }
});

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
    await db`insert into public.artifact_card_versions (workspace_id, card_id, version, title, kind, source, compiled, queries, params, prompt)
      values (${workspaceId}, ${cardId}, 1, ${`${title} card`}, 'code', ${CARD}, ${compileCard(CARD)}, ${queries}, ${db.json(PARAMS)}, 'Count my accounts on Home')`;

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

    // An older resize response arriving last must not replace the latest body.
    await page.route(`**/api/cards/${cardId}?*`, async route => {
      const response = await route.fetch();
      if (new URL(route.request().url()).searchParams.get("size") === "M") await new Promise(resolve => setTimeout(resolve, 800));
      // The page may have cancelled this older request while it was held back.
      await route.fulfill({ response }).catch(() => {});
    });
    const resize = page.getByRole("button", { name: new RegExp(`^Resize ${title} card`) });
    await resize.focus();
    const firstRequest = page.waitForRequest(request => request.url().includes(`/api/cards/${cardId}?`) && new URL(request.url()).searchParams.get("size") === "M");
    await page.keyboard.press("ArrowRight");
    await firstRequest;
    await page.keyboard.press("ArrowRight");
    await expect(card.getByText("Picked b at L")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    await expect(card.getByText("Picked b at L")).toBeVisible();
    // Returning to the already displayed width must also invalidate the pending request.
    await resize.focus();
    const returning = page.waitForRequest(request => request.url().includes(`/api/cards/${cardId}?`) && new URL(request.url()).searchParams.get("size") === "M");
    await page.keyboard.press("ArrowLeft");
    await returning;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1200);
    await expect(card.getByText("Picked b at L")).toBeVisible();
    await page.unroute(`**/api/cards/${cardId}?*`);
    // Return to S for the existing publish/restore checks below.
    await resize.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(card.getByText("Picked b at S")).toBeVisible({ timeout: 30_000 });

    // Hide, reload past Undo, then restore the published card directly from Home.
    const widget = page.locator(`[data-widget="card:${cardId}"]`);
    await widget.hover();
    await widget.getByRole("button", { name: `Hide ${title} card` }).click();
    await expect(widget).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add widget", exact: true }).click();
    await page.getByRole("list", { name: "Hidden widgets" }).getByRole("button", { name: `${title} card`, exact: true }).click();
    await expect(card.getByText("Picked a at S")).toBeVisible({ timeout: 30_000 });

    // A draft (here, renamed) doesn't change Home until it is published.
    await db`insert into public.artifact_card_versions (workspace_id, card_id, version, title, kind, source, compiled, queries, params, prompt)
      values (${workspaceId}, ${cardId}, 2, ${`${title} renamed`}, 'code', ${CARD}, ${compileCard(CARD)}, ${queries}, ${db.json(PARAMS)}, 'Rename it')`;
    await page.reload();
    await expect(page.getByRole("region", { name: `${title} card`, exact: true }).getByText("Picked a at S")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: `${title} renamed`, exact: true })).toHaveCount(0);

    // Deleting the artifact takes its card off Home.
    await page.goto("/ai/artifacts");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: `Delete ${title}` }).click();
    await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(tile).toHaveCount(0);
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

test("an empty Home cards tab sends the build request only after a press", async ({ page }) => {
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const [{ id }] = await db`insert into public.artifacts (workspace_id, title) values (${workspaceId}, 'Home card start QA') returning id`;
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const requests: { message: string }[] = [];
  await page.route("**/api/chat", async route => {
    requests.push(route.request().postDataJSON());
    await waiting;
    await route.fulfill({ json: { answer: "Build test complete", conversationId: route.request().postDataJSON().conversationId } });
  });
  try {
    // A link alone never sends anything, whatever it carries.
    await page.goto(`/ai/artifacts/${id}?tab=cards&start=${encodeURIComponent("Sent by a link")}`);
    await expect(page.getByRole("button", { name: "Create a Home card", exact: true })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(requests).toEqual([]);
    await page.getByRole("button", { name: "Create a Home card", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Building your Home card" })).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].message).toContain("Create a Home card from this artifact");
    await expect(page.getByText(requests[0].message, { exact: true })).toBeVisible();
    finish();
    await expect(page.getByText("Build test complete", { exact: true })).toBeVisible();
  } finally {
    finish();
    await page.unrouteAll({ behavior: "wait" });
    await db`delete from public.artifacts where id = ${id}`;
    await db.end();
  }
});

test("a new artifact sends its first request once, and a failed one takes a press", async ({ page }) => {
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const [{ id }] = await db`insert into public.artifacts (workspace_id, title, first_prompt) values (${workspaceId}, 'First request QA', 'Build the first page') returning id`;
  const requests: string[] = [];
  await page.route("**/api/chat", async route => { requests.push(route.request().postDataJSON().message); await route.fulfill({ status: 500, json: { error: "Synthetic failure" } }); });
  try {
    await page.goto(`/ai/artifacts/${id}`);
    await expect.poll(() => requests).toEqual(["Build the first page"]);
    await page.reload();
    const again = page.getByRole("button", { name: "Send it again", exact: true });
    await expect(again).toBeVisible();
    await page.waitForTimeout(1000);
    expect(requests).toHaveLength(1);
    await again.click();
    await expect.poll(() => requests).toHaveLength(2);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await db`delete from public.artifacts where id = ${id}`;
    await db.end();
  }
});

test("an unfinished artifact shows progress on return and keeps scrolling inside chat", async ({ page }) => {
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const title = `Building QA ${randomUUID().slice(0, 8)}`;
  const [{ id }] = await db`insert into public.artifacts (workspace_id, title) values (${workspaceId}, ${title}) returning id`;
  const [{ id: conversationId }] = await db`insert into public.conversations (workspace_id, artifact_id, title) values (${workspaceId}, ${id}, ${title}) returning id`;
  const requestId = randomUUID();
  try {
    await db`insert into public.chat_requests (id, workspace_id, conversation_id, message, status) values (${requestId}, ${workspaceId}, ${conversationId}, 'Build my page', 'running')`;
    for (let i = 0; i < 12; i++) await db`insert into public.messages (workspace_id, conversation_id, role, content) values (${workspaceId}, ${conversationId}, 'user', ${`Message ${i}: ${'Long conversation content. '.repeat(30)}`})`;
    await page.goto('/ai/artifacts');
    const tile = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: title, exact: true }) });
    await expect(tile.getByRole('status')).toHaveText('Building your artifact…');
    await expect(tile.locator('iframe')).toHaveCount(0);
    await page.getByRole('link', { name: title, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Artifact', exact: true }).getByRole('status')).toContainText('Building your artifact');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => {
        const chat = document.querySelector('[aria-label="Artifact chat messages"]')!;
        return { pageFits: document.documentElement.scrollHeight <= innerHeight + 1, chatScrolls: chat.scrollHeight > chat.clientHeight };
      })).toEqual({ pageFits: true, chatScrolls: true });
    }
    await page.goto('/ai/artifacts');
    await db`insert into public.artifact_versions (workspace_id, artifact_id, version, prompt, html, queries) values (${workspaceId}, ${id}, 1, 'Build my page', '<html><body>Finished page</body></html>', '[]')`;
    await db`update public.chat_requests set status='completed' where id=${requestId}`;
    await expect(tile.frameLocator('iframe').getByText('Finished page')).toBeVisible({ timeout: 15000 });
  } finally {
    await db`delete from public.messages where conversation_id=${conversationId}`;
    await db`delete from public.artifacts where id=${id}`;
    await db.end();
  }
});
