// Sets up (or upgrades) a self-hosted Moneo: fills .env with fresh secrets, starts the Docker
// backend, applies pending migrations and creates the single owner account. Safe to rerun
// after every `git pull`; existing secrets and data are kept.
//   npm run setup
// `npm run setup -- --qa` sets up the separate test backend instead: Docker project moneo-qa with its
// own volumes and ports, secrets in .env.qa, no background jobs. Tests use only that one.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";

const qa = process.argv.includes("--qa");
const ENV = qa ? ".env.qa" : ".env";
// Every checkout shares one test backend, so its secrets live once in the home folder too; a new
// worktree picks them up instead of making new ones that no longer match the Docker volumes.
const SHARED_QA = join(homedir(), ".moneo", "qa.env");
if (qa && !existsSync(ENV) && existsSync(SHARED_QA)) copyFileSync(SHARED_QA, ENV);
if (!existsSync(ENV)) copyFileSync(".env.example", ENV);
let text = readFileSync(ENV, "utf8");
const read = key => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].trim().replace(/^"(.*)"$/, "$1") ?? "";
const write = (key, value) => {
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
};

const url = read("NEXT_PUBLIC_SUPABASE_URL");
if (url && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url))
  throw new Error(`.env points at a hosted Supabase (${url}). Move that .env aside to set up a self-hosted Moneo.`);

const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");
const jwt = (role, key) => {
  const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: "supabase", role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86_400 })}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
};

const generated = [];
const ensure = (key, make) => { if (!read(key)) { write(key, make()); generated.push(key); } };
ensure("POSTGRES_PASSWORD", () => secret(24));
ensure("JWT_SECRET", () => secret(48));
// The API keys are signed with JWT_SECRET, so they are remade whenever it is new.
if (generated.includes("JWT_SECRET") || !read("SUPABASE_SERVICE_ROLE_KEY")) {
  write("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", jwt("anon", read("JWT_SECRET")));
  write("SUPABASE_SERVICE_ROLE_KEY", jwt("service_role", read("JWT_SECRET")));
}
if (qa) { ensure("API_PORT", () => "54521"); ensure("DB_PORT", () => "54522"); }
const apiPort = read("API_PORT") || "54321", dbPort = read("DB_PORT") || "54322";
write("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${apiPort}`);
write("SUPABASE_DB_URL", `postgresql://postgres:${read("POSTGRES_PASSWORD")}@127.0.0.1:${dbPort}/postgres`);
if (qa) write("NEXT_PUBLIC_APP_URL", "http://localhost:3100");
else ensure("NEXT_PUBLIC_APP_URL", () => "http://localhost:3000");
ensure("BANK_TOKEN_ENCRYPTION_KEY", () => randomBytes(32).toString("base64"));
ensure("CRON_SECRET", () => secret());
ensure("MONEO_OWNER_EMAIL", () => "owner@moneo.local");
ensure("MONEO_OWNER_PASSWORD", () => secret(24));
writeFileSync(ENV, text);
if (qa) { mkdirSync(dirname(SHARED_QA), { recursive: true }); writeFileSync(SHARED_QA, text); }
if (generated.length) console.log(`Generated in .env: ${generated.join(", ")}`);

try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch (error) {
  console.error(error.code === "ENOENT"
    ? "\nDocker is not installed. Install Docker Desktop from https://docs.docker.com/get-docker/, start it, then run npm run setup again."
    : "\nDocker is not running. Start Docker Desktop, wait until it says it is running, then run npm run setup again.");
  process.exit(1);
}
console.log("Starting the database and services (the first run downloads a few GB and takes several minutes)…");
execFileSync("docker", ["compose", ...(qa ? ["-p", "moneo-qa", "--env-file", ENV] : []), "up", "--detach", "--wait"], { stdio: "inherit" });

// Same history table as the Supabase CLI, so `supabase migration` commands keep working.
const db = postgres(read("SUPABASE_DB_URL"), { max: 1, onnotice: () => {} });
try {
  await db`create schema if not exists supabase_migrations`;
  await db`create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`;
  const applied = new Set((await db`select version from supabase_migrations.schema_migrations`).map(row => row.version));
  const pending = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort().filter(file => !applied.has(file.split("_")[0]));
  for (const file of pending) {
    const source = readFileSync(`supabase/migrations/${file}`, "utf8"), version = file.split("_")[0];
    await db.begin(async tx => {
      await tx.unsafe(source);
      await tx`insert into supabase_migrations.schema_migrations (version, name, statements) values (${version}, ${file.slice(version.length + 1, -4)}, ${[source]})`;
    });
  }
  console.log(pending.length ? `Applied ${pending.length} migration(s).` : "Database is up to date.");
  // PostgREST caches the schema; reload it after migrations.
  if (pending.length) await db`notify pgrst, 'reload schema'`;
} finally {
  await db.end();
}

// The owner signs in automatically (see proxy.ts); the password only lives in .env.
const response = await fetch(`${read("NEXT_PUBLIC_SUPABASE_URL")}/auth/v1/admin/users`, {
  method: "POST",
  headers: { authorization: `Bearer ${read("SUPABASE_SERVICE_ROLE_KEY")}`, apikey: read("SUPABASE_SERVICE_ROLE_KEY"), "content-type": "application/json" },
  body: JSON.stringify({ email: read("MONEO_OWNER_EMAIL"), password: read("MONEO_OWNER_PASSWORD"), email_confirm: true }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok && body.error_code !== "email_exists") throw new Error(`Could not create the owner account: ${response.status} ${JSON.stringify(body)}`);
console.log(response.ok ? "Created the owner account." : "Owner account exists.");
// Enable Banking only accepts https:// return addresses, so the bank sends you back to
// https://localhost:3443. mkcert (the tool Next.js uses for local HTTPS) makes a certificate that
// only this computer trusts; the first run may ask you to allow it.
if (qa) {
  console.log("The test backend is ready (.env.qa). Next: npm run qa:auth, then npm run test:e2e or npm run test:db.");
  process.exit(0);
}
try {
  // Browsers only: skip the Java keystore, which needs admin rights and which Moneo does not use.
  process.env.TRUST_STORES = "system,nss";
  const { createSelfSignedCertificate } = createRequire(import.meta.url)("next/dist/lib/mkcert.js");
  if (!(await createSelfSignedCertificate("localhost", ".data"))) throw new Error("mkcert did not create a certificate");
  console.log("Local HTTPS certificate for bank connections is ready.");
} catch (error) {
  console.warn(`Could not create the local HTTPS certificate (${error.message}). Bank connections need it; rerun setup to try again.`);
}

console.log(`
Setup is done. Next:
  1. Start Moneo:  npm run build && npm start   (npm run dev while developing)
  2. Open ${read("NEXT_PUBLIC_APP_URL")}
  3. In Settings → Keys and connections, sign in with ChatGPT or paste an OpenAI API key.
     Connecting a bank or Scalable Capital is optional and is done there too.
     So is using Moneo from your phone or tablet (Phone and tablet).
You never need to edit .env.`);
