import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { findWorkspaceEnvFile, loadEnv } from "@moneo/shared/env";

const env = loadEnv();
const envFile = findWorkspaceEnvFile();
if (env.APP_ENV !== "development" || !envFile || !env.DATABASE_MIGRATION_URL)
  throw new Error("Local development .env and DATABASE_MIGRATION_URL are required.");
const ownerUrl = new URL(env.DATABASE_MIGRATION_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(ownerUrl.hostname))
  throw new Error("Local setup only supports loopback PostgreSQL.");
const client = new Client({ connectionString: ownerUrl.toString() });
await client.connect();
try {
  let contents = readFileSync(envFile, "utf8");
  for (const [variable, role] of [
    ["DATABASE_URL", "moneo_app"],
    ["OUTBOX_DATABASE_URL", "moneo_dispatcher"],
  ] as const) {
    const password = randomBytes(32).toString("hex");
    // Role names are fixed above; generated passwords contain only hex digits.
    await client.query(`ALTER ROLE ${role} LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${password}'`);
    const url = new URL(ownerUrl);
    url.username = role;
    url.password = password;
    const line = `${variable}=${url.toString()}`;
    const pattern = new RegExp(`^${variable}=.*$`, "m");
    contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents}\n${line}\n`;
  }
  writeFileSync(envFile, contents, { mode: 0o600 });
  console.log(
    "Local runtime roles provisioned; connection URLs saved privately to .env. Restart web and worker.",
  );
} finally {
  await client.end();
}
