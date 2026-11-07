import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { compileCard } from "../lib/cards/sandbox";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());

// Saved directly, as the artifact's chat would save it, so no AI provider is called.
const CARD = `export default function Card({ params }) {
  const total = BigInt(params.monthly) * BigInt(params.yearly ? 12 : 1);
  return <div style={{ display: "grid", gap: 10 }}>
    <Kit.Param name="monthly" />
    <Kit.Param name="yearly" />
    <p className="font-display" style={{ fontSize: 36, fontWeight: 600, whiteSpace: "nowrap", margin: 0 }}><Kit.Money minor={total.toString()} currency="EUR" /></p>
    <p className="text-xs text-muted-foreground">{params.yearly ? "Saved per year" : "Saved per month"} (estimate)</p>
  </div>;
}`;
const PARAMS = [{ kind: "number", name: "monthly", label: "Each month", min: 0, max: 100000, step: 5000, default: 20000, format: "money", currency: "EUR" },
  { kind: "toggle", name: "yearly", label: "Show per year", default: false }];

test("a card's slider and switch recalculate it in the browser, without asking the server", async ({ page }) => {
  test.setTimeout(90_000);
  const title = `Slider QA ${randomUUID().slice(0, 8)}`;
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const [{ id }] = await db`insert into public.artifacts (workspace_id, title) values (${workspaceId}, ${title}) returning id`;
  try {
    const [{ id: cardId }] = await db`insert into public.artifact_cards (workspace_id, artifact_id, title) values (${workspaceId}, ${id}, ${`${title} card`}) returning id`;
    await db`insert into public.artifact_card_versions (workspace_id, card_id, version, title, kind, source, compiled, queries, params, prompt)
      values (${workspaceId}, ${cardId}, 1, ${`${title} card`}, 'code', ${CARD}, ${compileCard(CARD)}, ${db.json([])}, ${db.json(PARAMS)}, 'What if I saved more')`;
    const server: string[] = [];
    page.on("request", request => { if (request.url().includes(`/api/cards/${cardId}`)) server.push(request.url()); });

    await page.goto(`/ai/artifacts/${id}?tab=cards`);
    const card = page.getByRole("region", { name: `${title} card`, exact: true });
    // The workspace locale decides how money looks (€200.00 or EUR 200.00), so only the figures are checked.
    const total = card.getByRole("paragraph").first();
    await expect(total).toHaveText(/200\.00/, { timeout: 30_000 });
    const slider = card.getByRole("slider", { name: /^Each month/ });
    await expect(slider).toHaveAttribute("aria-valuetext", /200\.00/);

    // A move before the page has hydrated is undone by React, so the first move is repeated until the card answers.
    await expect(async () => { await slider.fill("50000"); await expect(total).toHaveText(/500\.00/, { timeout: 2000 }); }).toPass({ timeout: 20_000 });
    await expect(slider).toHaveAttribute("aria-valuetext", /500\.00/);
    await card.getByRole("switch", { name: "Show per year" }).click();
    await expect(total).toHaveText(/6,?000\.00/);
    await expect(card.getByText("Saved per year (estimate)")).toBeVisible();
    await expect(card.getByRole("switch", { name: "Show per year" })).toHaveAttribute("aria-checked", "true");
    expect(server).toEqual([]);

    const shots = process.env.E2E_SCREENSHOT_DIR;
    if (shots) for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await card.screenshot({ path: `${shots}/slider-card-${scheme}.png` });
    }
  } finally {
    await db`delete from public.artifacts where id = ${id}`;
    await db.end();
  }
});
