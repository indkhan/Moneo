import { spawn } from "node:child_process";
type Phase = "after-claim" | "after-provider-response" | "after-tool-commit" | "after-publish";

export async function killDurableChild(
  input: { phase: Phase; tenantId: string; operationId: string; leaseMs: number },
): Promise<{ marker: Phase; killed: boolean }> {
  const child = spawn(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "proof/durable/kill-worker-child.test.ts", "--pool=threads", "--maxWorkers=1"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        E00_KILL_PHASE: input.phase,
        E00_KILL_TENANT: input.tenantId,
        E00_KILL_OPERATION: input.operationId,
        E00_KILL_LEASE_MS: String(input.leaseMs),
      },
    },
  );
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`durable kill child did not reach ${input.phase}`));
    }, 10_000);
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes(`${input.phase}\n`)) return;
      child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("exit", (_code, signal) => {
      clearTimeout(timeout);
      if (!stdout.includes(`${input.phase}\n`)) {
        reject(new Error(`durable kill child exited before marker: ${stderr.trim() || "no stderr"}`));
        return;
      }
      resolve({ marker: input.phase, killed: signal !== null || child.killed });
    });
  });
}
