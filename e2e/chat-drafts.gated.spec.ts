import { readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { expect, test } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

for (const panel of [false, true]) {
  test(`${panel ? "panel" : "first saved conversation"} retains the next question typed during an answer`, async ({ page }) => {
    const cookies = JSON.parse(readFileSync(state!, "utf8")).cookies;
    const db = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      cookies: { getAll: () => cookies, setAll: () => {} },
    });
    const { data: { user }, error: authError } = await db.auth.getUser();
    expect(authError).toBeNull();
    const { data: workspace, error: workspaceError } = await db.from("workspaces").select("id").eq("owner_id", user!.id).single();
    expect(workspaceError).toBeNull();
    let conversationId: string | undefined, submitted = "";
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/chat", async route => {
      const payload = route.request().postDataJSON();
      conversationId = payload.conversationId;
      submitted = payload.message;
      // Retain the same owned thread that production creates before answering.
      const created = await db.from("conversations").insert({ id: conversationId, workspace_id: workspace!.id, title: "Synthetic draft handoff" });
      expect(created.error).toBeNull();
      await responseReady;
      await route.fulfill({ json: { conversationId, answer: "Synthetic completed answer" } });
    });
    try {
      await page.goto(panel ? "/money/transactions" : "/ai?conversation=new");
      if (panel) await page.getByRole("button", { name: "Ask Moneo" }).click();
      const scope = panel ? page.getByRole("dialog", { name: "AI assistant" }) : page.locator("main");
      const input = scope.getByLabel(panel ? "Question" : "Ask about your finances", { exact: true });
      await input.fill("Submitted question");
      await scope.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => submitted).toBe("Submitted question");
      await input.fill("Next question draft");
      release();
      if (!panel) await expect(page).toHaveURL(new RegExp(`conversation=${conversationId}$`));
      await expect(scope.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await expect(input).toHaveValue("Next question draft");
      if (!panel) {
        await page.getByRole("link", { name: "New conversation", exact: true }).click();
        await expect(input).toHaveValue("");
      }
    } finally {
      release();
      if (conversationId) expect((await db.from("conversations").delete().eq("id", conversationId).eq("workspace_id", workspace!.id)).error).toBeNull();
    }
  });
}
