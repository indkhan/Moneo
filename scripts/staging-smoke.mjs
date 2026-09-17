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

async function runAndProbe(tag, name, hostPort) {
  sh(["docker", "run", "-d", "--rm", "--name", name, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "-p", `127.0.0.1:${hostPort}:3000`, tag]);
  try {
    const body = await waitForHealth(hostPort, 90_000);
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

const imageEnv = sh(["docker", "inspect", "-f", "{{json .Config.Env}}", CANDIDATE]);
for (const name of SECRET_NAMES) {
  const hit = imageEnv.split(",").find((entry) => entry.includes(name) && !entry.replaceAll('"', "").endsWith(`${name}=`));
  if (hit && !hit.endsWith('=') && !hit.endsWith('="')) throw new Error(`staging smoke failed: image config carries a value for ${name}.`);
}
console.log("staging smoke: image config carries no secret values");

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
} else {
  console.log("staging smoke: no prior tag existed; rollback path recorded for the next deploy (tag staging-current -> staging-previous above).");
}
console.log("staging smoke: PASS");
