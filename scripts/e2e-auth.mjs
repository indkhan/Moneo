import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";

const ENV = ".env.qa";
if (!existsSync(ENV)) throw new Error("No .env.qa: run `npm run setup -- --qa` first.");
process.loadEnvFile(ENV);
const statePath = "e2e/.auth.json";
let email = process.env.E2E_USER_EMAIL, password = process.env.E2E_USER_PASSWORD;

if (process.argv.includes("--reset")) {
  if (!email) throw new Error("No E2E_USER_EMAIL in .env.qa; run npm run qa:auth first");
  const db = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  await db.begin(async tx => {
    const [user] = await tx`select id, raw_user_meta_data->>'qa_test' as qa from auth.users where email=${email}`;
    if (user?.qa !== "e2e-auth") throw new Error("Refusing to reset a user not created by this script");
    await tx`select set_config('request.jwt.claim.sub', ${user.id}, true)`;
    await tx`select public.reset_workspace()`;
  });
  await db.end();
  console.log("Emptied the QA user's workspace");
  process.exit(0);
}

if (!email) {
  email = `qa-${Date.now()}@example.test`;
  password = randomBytes(24).toString("base64url");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "e2e-auth" } });
  if (error) throw error;
  let text = readFileSync(ENV, "utf8");
  for (const [key, value] of [["E2E_USER_EMAIL", email], ["E2E_USER_PASSWORD", password]])
    text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(ENV, text);
  writeFileSync(join(homedir(), ".moneo", "qa.env"), text);
}

const cookies = [];
const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  cookies: { getAll: () => [], setAll: list => cookies.push(...list) },
});
const { error } = await auth.auth.signInWithPassword({ email, password });
if (error) throw error;
const { hostname } = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3100");
const expires = Math.floor(Date.now() / 1000) + 400 * 86_400;
writeFileSync(statePath, JSON.stringify({ cookies: cookies.map(({ name, value }) => ({ name, value, domain: hostname, path: "/", expires, httpOnly: false, secure: false, sameSite: "Lax" })), origins: [] }, null, 2));
console.log(`Saved ${statePath} for ${email}`);
