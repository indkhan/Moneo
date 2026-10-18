// Creates a disposable confirmed QA user, signs in through the local /login page and
// saves e2e/.auth.json for the authenticated Playwright specs.
// Run with the app on http://localhost:3000:  node --env-file=.env scripts/e2e-auth.mjs
// Remove the user afterwards:                 node --env-file=.env scripts/e2e-auth.mjs --delete
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";

const journal = ".qa/e2e-auth-user.json", statePath = "e2e/.auth.json";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

if (process.argv.includes("--delete")) {
  if (!existsSync(journal)) throw new Error(`No ${journal}; nothing to delete`);
  const { id } = JSON.parse(readFileSync(journal, "utf8"));
  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) throw error;
  rmSync(journal); rmSync(statePath, { force: true });
  console.log("Deleted QA user and auth state");
  process.exit(0);
}

const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const email = `qa-${Date.now()}@example.test`, password = randomBytes(24).toString("base64url");
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "e2e-auth" } });
if (error) throw error;
mkdirSync(".qa", { recursive: true });
writeFileSync(journal, JSON.stringify({ id: data.user.id, email }));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ baseURL: base });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.context().storageState({ path: statePath });
  console.log(`Saved ${statePath} for ${email}`);
} catch (cause) {
  await admin.auth.admin.deleteUser(data.user.id); // don't leave an orphan behind a failed sign-in
  rmSync(journal);
  throw cause;
} finally {
  await browser.close();
}
