// E01-S02 production entrypoint: serves the S01 health surface always, and
// the auth slice only when fully configured (issuer + client + secret +
// database). Partial identity configuration refuses to start rather than
// serving half-secured auth. Logs only the bound address and release, never
// env values or request data.

import { join } from "node:path";
import { createApp } from "./server.ts";
import { createAuthRouter } from "./auth.ts";
import { createPool, migrate } from "./db.ts";

const port = Number(process.env["PORT"] ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("E01-S02: PORT must be an integer 1-65535.");
  process.exit(1);
}

const issuer = process.env["KEYCLOAK_ISSUER"] ?? "";
const clientId = process.env["KEYCLOAK_CLIENT_ID"] ?? "";
const clientSecret = process.env["KEYCLOAK_CLIENT_SECRET"] ?? "";
const sessionSecret = process.env["SESSION_SECRET"] ?? "";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const appBaseUrl = process.env["APP_BASE_URL"] ?? `http://127.0.0.1:${port}`;
const authConfigured = Boolean(issuer && clientId && sessionSecret && databaseUrl);

if ((issuer || clientId || sessionSecret) && !authConfigured) {
  console.error("E01-S02 refused: partial auth configuration (need KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, SESSION_SECRET and DATABASE_URL).");
  process.exit(1);
}

async function start(): Promise<void> {
  if (!authConfigured) {
    const server = createApp(null);
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(port, "0.0.0.0", () => {
      console.log(`moneo-web listening on :${port} release=${process.env["APP_RELEASE"] ?? "dev"} auth=off`);
    });
    return;
  }
  const pool = createPool(databaseUrl);
  try {
    await migrate(pool, join(process.cwd(), "apps", "web", "migrations"));
  } catch (err) {
    console.error(`E01-S02: migration failed (${(err as Error).message}).`);
    process.exit(1);
  }
  const sessionTtlSec = Number(process.env["SESSION_TTL_SEC"] ?? "43200");
  if (!Number.isInteger(sessionTtlSec) || sessionTtlSec < 60 || sessionTtlSec > 30 * 24 * 3600) {
    console.error("E01-S02 refused: SESSION_TTL_SEC must be an integer 60-2592000.");
    process.exit(1);
  }
  const router = createAuthRouter(
    {
      issuer,
      clientId,
      clientSecret,
      appBaseUrl,
      sessionSecret,
      sessionTtlSec,
    },
    pool,
  );
  const server = createApp(router);
  server.on("clientError", (_err, socket) => socket.destroy());
  server.listen(port, "0.0.0.0", () => {
    console.log(`moneo-web listening on :${port} release=${process.env["APP_RELEASE"] ?? "dev"} auth=on`);
  });
}

void start();
