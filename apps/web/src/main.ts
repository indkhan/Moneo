// E01-S06 production entrypoint: serves the S01 health surface always, and
// the auth/tenancy/UI slices only when fully configured (issuer + client +
// secret + database). Partial identity configuration refuses to start rather
// than serving half-secured auth. Startup/request logs carry release,
// addresses and redacted request lines only — never env values, request
// data, subjects or tokens.

import { join } from "node:path";
import { createApp } from "./server.ts";
import { createAuthRouter, requestSession } from "./auth.ts";
import { createPool, migrate } from "./db.ts";
import { createControls, type LogLine } from "./http-controls.ts";
import { createTenancyRouter } from "./tenancy.ts";
import { createUiRouter } from "./ui/routes.ts";

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

if ((issuer || clientId || clientSecret || sessionSecret) && !authConfigured) {
  console.error("E01-S02 refused: partial auth configuration (need KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, SESSION_SECRET and DATABASE_URL).");
  process.exit(1);
}

const sessionTtlSec = Number(process.env["SESSION_TTL_SEC"] ?? "43200");
if (!Number.isInteger(sessionTtlSec) || sessionTtlSec < 60 || sessionTtlSec > 30 * 24 * 3600) {
  console.error("E01-S02 refused: SESSION_TTL_SEC must be an integer 60-2592000.");
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
  const tenancy = createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req));
  const ui = createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), { appBaseUrl, sessionSecret });
  const controls = createControls({
    logger: (line: LogLine) => console.log(JSON.stringify(line)),
  });
  const server = createApp(router, tenancy, {
    ui,
    controls,
    dbPing: async () => {
      const rows = await pool.query("SELECT 1 AS ok");
      return (rows.rowCount ?? 0) === 1;
    },
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  server.listen(port, "0.0.0.0", () => {
    console.log(`moneo-web listening on :${port} release=${process.env["APP_RELEASE"] ?? "dev"} auth=on`);
  });
}

void start();
