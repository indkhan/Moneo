import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.7.4";
const ALPINE_IMAGE = "alpine:3.22.1";

function docker(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`Docker proof command failed (${args[0] ?? "unknown"}); exit ${result.status ?? "signal"}.`);
  }
  return result.stdout.trim();
}

async function form(url: string, values: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(30_000),
  });
}

export async function runDockerIdentityProof(): Promise<{
  keycloakImage: string;
  login: boolean;
  refreshBeforeRevocation: boolean;
  refreshAfterRevocationDenied: boolean;
  nonRootReadOnly: boolean;
  grantedSecret: boolean;
  ungrantedSecretDenied: boolean;
}> {
  const dir = mkdtempSync(join(tmpdir(), "moneo-e00-identity-"));
  const name = `moneo-e00-keycloak-${process.pid}-${Date.now()}`;
  const realm = "moneo-proof";
  const clientId = "moneo-proof-client";
  const userId = randomUUID();
  const user = "proof-user";
  const admin = "proof-admin";
  const password = `Aa1!${randomBytes(24).toString("hex")}`;
  const adminPassword = `Aa1!${randomBytes(24).toString("hex")}`;
  const clientSecret = randomBytes(32).toString("base64url");
  const serviceSecret = randomBytes(32).toString("base64url");
  const realmPath = join(dir, "realm.json");
  const secretPath = join(dir, "service-secret");
  writeFileSync(secretPath, serviceSecret);
  writeFileSync(realmPath, JSON.stringify({
    realm,
    enabled: true,
    clients: [{
      clientId,
      secret: clientSecret,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: true,
      redirectUris: ["http://127.0.0.1/*"],
    }],
    users: [{
      id: userId,
      username: user,
      enabled: true,
      email: "proof-user@example.invalid",
      firstName: "Synthetic",
      lastName: "Proof",
      emailVerified: true,
      requiredActions: [],
      credentials: [{ type: "password", value: password, temporary: false }],
    }],
  }));

  try {
    docker(["pull", KEYCLOAK_IMAGE]);
    docker(["pull", ALPINE_IMAGE]);
    docker([
      "run", "-d", "--name", name,
      "-p", "127.0.0.1::8080",
      "-e", "KC_BOOTSTRAP_ADMIN_USERNAME",
      "-e", "KC_BOOTSTRAP_ADMIN_PASSWORD",
      "--mount", `type=bind,src=${realmPath},dst=/opt/keycloak/data/import/realm.json,readonly`,
      KEYCLOAK_IMAGE, "start-dev", "--import-realm",
    ], { KC_BOOTSTRAP_ADMIN_USERNAME: admin, KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword });
    const mapped = docker(["port", name, "8080/tcp"]);
    const port = mapped.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("Docker proof could not resolve the Keycloak port.");
    const base = `http://127.0.0.1:${port}`;
    const discovery = `${base}/realms/${realm}/.well-known/openid-configuration`;
    let ready = false;
    for (let i = 0; i < 90; i++) {
      try {
        ready = (await fetch(discovery, { signal: AbortSignal.timeout(1000) })).status === 200;
      } catch {
        ready = false;
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("Keycloak proof container did not become ready.");

    const tokenUrl = `${base}/realms/${realm}/protocol/openid-connect/token`;
    const login = await form(tokenUrl, {
      grant_type: "password", client_id: clientId, client_secret: clientSecret,
      username: user, password, scope: "openid",
    });
    const tokens = await login.json() as { refresh_token?: string; error?: string; error_description?: string };
    if (!tokens.refresh_token) {
      const detail = tokens.error_description?.replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 120) ?? "no-description";
      throw new Error(`Keycloak proof login failed with HTTP ${login.status} (${tokens.error ?? "unknown-oauth-error"}: ${detail}).`);
    }
    const refreshBefore = await form(tokenUrl, {
      grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
    });

    const adminLogin = await form(`${base}/realms/master/protocol/openid-connect/token`, {
      grant_type: "password", client_id: "admin-cli", username: admin, password: adminPassword,
    });
    const adminToken = (await adminLogin.json() as { access_token?: string }).access_token;
    if (!adminToken) throw new Error("Keycloak proof admin login failed.");
    const revoked = await fetch(`${base}/admin/realms/${realm}/users/${userId}/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const refreshAfter = await form(tokenUrl, {
      grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
    });

    const hardening = ["--network", "none", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"];
    const granted = docker([
      "run", "--rm", ...hardening,
      "--mount", `type=bind,src=${secretPath},dst=/run/secrets/proof,readonly`,
      ALPINE_IMAGE, "sh", "-c", "id -u; cat /run/secrets/proof",
    ]).split(/\r?\n/);
    const ungranted = docker([
      "run", "--rm", ...hardening, ALPINE_IMAGE,
      "sh", "-c", "test ! -e /run/secrets/proof && test ! -w /",
    ]);

    return {
      keycloakImage: KEYCLOAK_IMAGE,
      login: login.status === 200,
      refreshBeforeRevocation: refreshBefore.status === 200,
      refreshAfterRevocationDenied: revoked.status === 204 && refreshAfter.status === 400,
      nonRootReadOnly: granted[0] === "65532" && ungranted === "",
      grantedSecret: granted[1] === serviceSecret,
      ungrantedSecretDenied: ungranted === "",
    };
  } finally {
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", timeout: 30_000 });
    rmSync(dir, { recursive: true, force: true });
  }
}
