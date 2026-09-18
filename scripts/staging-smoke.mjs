// E01-S01 synthetic staging smoke: build the candidate image, run it as
// non-root with a read-only filesystem, prove /healthz serves, verify no
// secret names carry values into the image config, promote the candidate to
// the current tag, then demonstrate rollback by re-serving the prior tag.
// Disposable containers only; fail-closed cleanup. Never logs secret values.
import { spawnSync } from "node:child_process";

const CANDIDATE = "moneo-web:staging-candidate";
const CURRENT = "moneo-web:staging-current";
const PREVIOUS = "moneo-web:staging-previous";
const SECRET_NAMES = ["SESSION_SECRET", "DATABASE_URL", "DATABASE_MIGRATION_URL", "KEYCLOAK_CLIENT_SECRET", "REDIS_URL"];

function sh(args, opts = {}) {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 300_000, ...opts });
  if (result.status !== 0) {
    throw new Error(`staging smoke failed: ${args.join(" ")} exited ${result.status ?? "signal"}: ${(result.stderr ?? "").slice(0, 500)}`);
  }
  return (result.stdout ?? "").trim();
}

function shStatus(args) {
  return spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 60_000 }).status;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, deadlineMs) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) {
        const body = await res.json();
        if (body?.status === "ok" && body?.name === "moneo-web") return body;
      }
    } catch { /* not ready yet */ }
    if (Date.now() - started > deadlineMs) throw new Error(`staging smoke failed: /healthz never became ready on :${port}.`);
    await sleep(1000);
  }
}

async function runAndProbe(tag, name, hostPort, extraArgs = [], requireReady = false) {
  sh(["docker", "run", "-d", "--rm", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "-p", `127.0.0.1:${hostPort}:3000`, ...extraArgs, tag]);
  try {
    const body = await waitForHealth(hostPort, 90_000);
    if (requireReady) {
      const ready = await fetch(`http://127.0.0.1:${hostPort}/readyz`);
      if (ready.status !== 200) throw new Error(`staging smoke failed: configured /readyz returned ${ready.status}`);
    }
    const uid = sh(["docker", "exec", name, "id", "-u"]);
    if (uid === "0") throw new Error("staging smoke failed: app runs as root.");
    return body;
  } finally {
    shStatus(["docker", "rm", "-f", name]);
  }
}

const gitSha = process.env["GIT_SHA"] ?? "local";
console.log(`staging smoke: building ${CANDIDATE} (GIT_SHA redacted from log values)`);
sh(["docker", "build", "-f", "apps/web/Dockerfile", "-t", CANDIDATE, "--build-arg", "APP_RELEASE=staging", "--build-arg", `GIT_SHA=${gitSha}`, "."]);

const imageEnv = JSON.parse(sh(["docker", "inspect", "-f", "{{json .Config.Env}}", CANDIDATE]));
for (const name of SECRET_NAMES) {
  const hit = imageEnv.find((entry) => entry.startsWith(`${name}=`) && entry.length > name.length + 1);
  if (hit) throw new Error(`staging smoke failed: image config carries a value for ${name}.`);
}
console.log("staging smoke: image config carries no secret values");
sh(["docker", "run", "--rm", "--entrypoint", "node", CANDIDATE, "-e", "require('node:fs').accessSync('/app/apps/web/migrations/004_ai_policy.sql')"]);
console.log("staging smoke: runtime migrations present");

const configuredNetwork = "moneo-e01-smoke-configured";
const configuredDb = "moneo-e01-smoke-pg";
if (shStatus(["docker", "network", "inspect", configuredNetwork]) === 0 || shStatus(["docker", "container", "inspect", configuredDb]) === 0) {
  throw new Error("staging smoke refused: configured-smoke resources already exist");
}
sh(["docker", "network", "create", configuredNetwork]);
try {
  sh(["docker", "run", "-d", "--rm", "--name", configuredDb, "--network", configuredNetwork,
    "-e", "POSTGRES_USER=moneo", "-e", "POSTGRES_PASSWORD=synthetic-only", "-e", "POSTGRES_DB=moneo",
    "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73"]);
  for (let i = 0; i < 30 && shStatus(["docker", "exec", configuredDb, "pg_isready", "-U", "moneo", "-d", "moneo"]) !== 0; i++) await sleep(1000);
  if (shStatus(["docker", "exec", configuredDb, "pg_isready", "-U", "moneo", "-d", "moneo"]) !== 0) throw new Error("staging smoke failed: configured PostgreSQL never became ready");
  const configured = await runAndProbe(CANDIDATE, "moneo-e01-smoke-configured-app", 3104, ["--network", configuredNetwork,
    "-e", "DATABASE_URL=postgresql://moneo:synthetic-only@moneo-e01-smoke-pg:5432/moneo",
    "-e", "KEYCLOAK_ISSUER=http://keycloak.invalid/realms/moneo", "-e", "KEYCLOAK_CLIENT_ID=moneo-web",
    "-e", "KEYCLOAK_CLIENT_SECRET=synthetic-only-client-secret",
    "-e", "SESSION_SECRET=synthetic-only-session-secret-32b", "-e", "APP_BASE_URL=http://127.0.0.1:3104"], true);
  console.log(`staging smoke: configured image serves /healthz release=${configured.release} and /readyz`);
} finally {
  shStatus(["docker", "rm", "-f", "moneo-e01-smoke-configured-app"]);
  shStatus(["docker", "rm", "-f", configuredDb]);
  shStatus(["docker", "network", "rm", configuredNetwork]);
}

const hadCurrent = shStatus(["docker", "image", "inspect", CURRENT]) === 0;
if (hadCurrent) {
  sh(["docker", "tag", CURRENT, PREVIOUS]);
  console.log("staging smoke: prior deployment saved as staging-previous");
}

const candidateBody = await runAndProbe(CANDIDATE, "moneo-e01-smoke-candidate", 3101);
console.log(`staging smoke: candidate serves /healthz release=${candidateBody.release}`);
sh(["docker", "tag", CANDIDATE, CURRENT]);

if (hadCurrent) {
  const rolled = await runAndProbe(PREVIOUS, "moneo-e01-smoke-rollback", 3102);
  console.log(`staging smoke: rollback to prior tag serves /healthz release=${rolled.release}`);
  sh(["docker", "tag", PREVIOUS, CURRENT]);
  const restored = await runAndProbe(CURRENT, "moneo-e01-smoke-restored", 3103);
  console.log(`staging smoke: restored current tag serves /healthz release=${restored.release}`);
} else {
  console.log("staging smoke: no prior tag existed; rollback path recorded for the next deploy (tag staging-current -> staging-previous above).");
}
console.log("staging smoke: PASS");
