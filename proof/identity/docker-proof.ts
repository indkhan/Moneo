import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak@sha256:82a77884f3af238beab1e7afd63b5f530e1b5c0590bd7aa60b40a40463e29b2c";
const ALPINE_IMAGE = "alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1";

function docker(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`Docker proof command failed (${args[0] ?? "unknown"}); exit ${result.status ?? "signal"}.`);
  return result.stdout.trim();
}

function dockerStatus(args: string[]): number | null {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 }).status;
}

async function form(url: string, values: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(30_000),
  });
}

async function authorizationCode(
  authorizationEndpoint: string,
  redirectUri: string,
  clientId: string,
  user: string,
  password: string,
  challenge: string,
  state: string,
): Promise<string> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
      rejectCode(new Error("Keycloak PKCE callback was missing code or valid state."));
      res.writeHead(400).end("invalid callback");
      return;
    }
    resolveCode(url.searchParams.get("code")!);
    res.writeHead(200, { "Content-Type": "text/plain" }).end("complete");
  });
  await new Promise<void>((resolve) => server.listen(Number(new URL(redirectUri).port), "127.0.0.1", resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = new URL(authorizationEndpoint);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    })) url.searchParams.set(key, value);
    await page.goto(url.toString());
    await page.locator("#username").fill(user);
    await page.locator("#password").fill(password);
    await page.locator("#kc-login").click();
    return await Promise.race([
      codePromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Keycloak PKCE callback timed out.")), 30_000)),
    ]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function runDockerIdentityProof(): Promise<{
  keycloakImage: string;
  authorizationCodePkce: boolean;
  login: boolean;
  refreshBeforeRevocation: boolean;
  refreshAfterRevocationDenied: boolean;
  nonRootReadOnly: boolean;
  grantedSecret: boolean;
  ungrantedSecretDenied: boolean;
  networkRemoved: boolean;
}> {
  const dir = mkdtempSync(join(tmpdir(), "moneo-e00-identity-"));
  const suffix = `${process.pid}-${Date.now()}`;
  const name = `moneo-e00-keycloak-${suffix}`;
  const network = `moneo-e00-network-${suffix}`;
  const project = `moneoe00${process.pid}${Date.now()}`.toLowerCase();
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
  const composePath = join(dir, "compose.yml");
  let networkCreated = false;
  let containerCreated = false;
  let composeUsed = false;

  writeFileSync(secretPath, serviceSecret);
  writeFileSync(realmPath, JSON.stringify({
    realm, enabled: true,
    clients: [{ clientId, secret: clientSecret, enabled: true, publicClient: false, standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: ["http://127.0.0.1/*"] }],
    users: [{ id: userId, username: user, enabled: true, email: "proof-user@example.invalid", firstName: "Synthetic", lastName: "Proof", emailVerified: true, requiredActions: [], credentials: [{ type: "password", value: password, temporary: false }] }],
  }));
  const yamlPath = secretPath.replaceAll("\\", "/");
  writeFileSync(composePath, `services:
  granted:
    image: "${ALPINE_IMAGE}"
    network_mode: none
    read_only: true
    user: "65532:65532"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    secrets: [proof]
    command: ["sh", "-c", "id -u; cat /run/secrets/proof"]
  ungranted:
    image: "${ALPINE_IMAGE}"
    network_mode: none
    read_only: true
    user: "65532:65532"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    command: ["sh", "-c", "test ! -e /run/secrets/proof && test ! -w /"]
secrets:
  proof:
    file: "${yamlPath}"
`);

  let result: Omit<Awaited<ReturnType<typeof runDockerIdentityProof>>, "networkRemoved">;
  try {
    docker(["pull", KEYCLOAK_IMAGE]);
    docker(["pull", ALPINE_IMAGE]);
    docker(["network", "create", network]);
    networkCreated = true;
    docker(["run", "-d", "--name", name, "--network", network, "-p", "127.0.0.1::8080", "-e", "KC_BOOTSTRAP_ADMIN_USERNAME", "-e", "KC_BOOTSTRAP_ADMIN_PASSWORD", "--mount", `type=bind,src=${realmPath},dst=/opt/keycloak/data/import/realm.json,readonly`, KEYCLOAK_IMAGE, "start-dev", "--import-realm"], { KC_BOOTSTRAP_ADMIN_USERNAME: admin, KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword });
    containerCreated = true;
    const port = docker(["port", name, "8080/tcp"]).match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("Docker proof could not resolve the Keycloak port.");
    const base = `http://127.0.0.1:${port}`;
    const discoveryUrl = `${base}/realms/${realm}/.well-known/openid-configuration`;
    let discovery: { authorization_endpoint?: string; token_endpoint?: string } | undefined;
    for (let i = 0; i < 90; i++) {
      try {
        const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(1000) });
        if (response.status === 200) discovery = await response.json() as typeof discovery;
      } catch { /* still starting */ }
      if (discovery?.authorization_endpoint && discovery.token_endpoint) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!discovery?.authorization_endpoint || !discovery.token_endpoint) throw new Error("Keycloak proof container did not become ready.");

    const callback = createServer();
    await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
    const callbackAddress = callback.address();
    if (!callbackAddress || typeof callbackAddress === "string") throw new Error("Could not reserve PKCE callback port.");
    const redirectUri = `http://127.0.0.1:${callbackAddress.port}/callback`;
    await new Promise<void>((resolve) => callback.close(() => resolve()));
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    const code = await authorizationCode(discovery.authorization_endpoint, redirectUri, clientId, user, password, challenge, state);
    const login = await form(discovery.token_endpoint, { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code, code_verifier: verifier });
    const tokens = await login.json() as { refresh_token?: string };
    if (!tokens.refresh_token) throw new Error(`Keycloak PKCE token exchange failed with HTTP ${login.status}.`);
    const refreshBefore = await form(discovery.token_endpoint, { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refresh_token });
    const refreshed = await refreshBefore.json() as { refresh_token?: string };
    if (!refreshed.refresh_token) throw new Error(`Keycloak pre-revocation refresh failed with HTTP ${refreshBefore.status}.`);

    const adminLogin = await form(`${base}/realms/master/protocol/openid-connect/token`, { grant_type: "password", client_id: "admin-cli", username: admin, password: adminPassword });
    const adminToken = (await adminLogin.json() as { access_token?: string }).access_token;
    if (!adminToken) throw new Error("Keycloak proof admin login failed.");
    const revoked = await fetch(`${base}/admin/realms/${realm}/users/${userId}/logout`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(30_000) });
    const refreshAfter = await form(discovery.token_endpoint, { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshed.refresh_token });

    composeUsed = true;
    const compose = ["compose", "-f", composePath, "-p", project];
    const granted = docker([...compose, "run", "--rm", "--no-deps", "granted"]).split(/\r?\n/);
    const ungranted = docker([...compose, "run", "--rm", "--no-deps", "ungranted"]);
    result = {
      keycloakImage: KEYCLOAK_IMAGE,
      authorizationCodePkce: true,
      login: login.status === 200,
      refreshBeforeRevocation: refreshBefore.status === 200,
      refreshAfterRevocationDenied: revoked.status === 204 && refreshAfter.status === 400,
      nonRootReadOnly: granted[0] === "65532" && ungranted === "",
      grantedSecret: granted[1] === serviceSecret,
      ungrantedSecretDenied: ungranted === "",
    };
  } finally {
    const failures: string[] = [];
    if (composeUsed && dockerStatus(["compose", "-f", composePath, "-p", project, "down", "--remove-orphans"]) !== 0) failures.push("compose cleanup");
    if (containerCreated && dockerStatus(["rm", "-f", name]) !== 0) failures.push("container cleanup");
    if (containerCreated && dockerStatus(["inspect", name]) === 0) failures.push("container remains");
    if (networkCreated && dockerStatus(["network", "rm", network]) !== 0) failures.push("network cleanup");
    if (networkCreated && dockerStatus(["network", "inspect", network]) === 0) failures.push("network remains");
    rmSync(dir, { recursive: true, force: true });
    if (failures.length) throw new Error(`Docker identity proof cleanup failed: ${failures.join(", ")}.`);
  }
  return { ...result!, networkRemoved: true };
}
