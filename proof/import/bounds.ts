// E00-S03 bounded parent runner (Node-only test helper).
//
// Spawns the isolated parser child with the proof's resource envelope and
// returns a structured outcome. The wall-clock deadline is enforced by
// killing the child; memory is capped with --max-old-space-size. Callers
// prove recovery by running a healthy parse after a killed one.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROOF_LIMITS, type ImportProfile, type ProofLimits } from "./parser.ts";

export const CHILD_TIMEOUT_MS = 60_000;
export const CHILD_MEMORY_MB = 256;

export type BoundedOptions = {
  file: string;
  filename: string;
  profile: ImportProfile;
  limits?: Partial<ProofLimits>;
  prior?: { observationIds: string[]; keys: [string, string][] } | null;
  timeoutMs?: number;
  memoryMb?: number;
  hangMs?: number;
};

export type BoundedOutcome = {
  timedOut: boolean;
  exitCode: number | null;
  wallMs: number;
  // Parsed child result envelope when the child wrote one.
  body: Record<string, unknown> | null;
};

export function runBoundedParse(opts: BoundedOptions): BoundedOutcome {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "moneo-import-"));
  const jobPath = join(dir, "job.json");
  const outPath = join(dir, "out.json");
  writeFileSync(
    jobPath,
    JSON.stringify({
      file: opts.file,
      filename: opts.filename,
      profile: opts.profile,
      limits: opts.limits ?? null,
      prior: opts.prior ?? null,
      hangMs: opts.hangMs ?? 0,
      out: outPath,
    }),
  );
  // Resolved from the repository root, which is the working directory for
  // every documented proof command.
  const childPath = join(process.cwd(), "proof", "import", "child.ts");
  const res = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${opts.memoryMb ?? CHILD_MEMORY_MB}`,
      "--experimental-strip-types",
      childPath,
      "--job",
      jobPath,
    ],
    { timeout: opts.timeoutMs ?? CHILD_TIMEOUT_MS, encoding: "utf-8" },
  );
  const wallMs = Date.now() - started;
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
  } catch {
    body = null;
  }
  // spawnSync reports a kill via `signal`; a timeout surfaces as either an
  // ETIMEDOUT error or a non-null signal, on POSIX and Windows alike.
  const timedOut =
    (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || res.signal !== null;
  return { timedOut, exitCode: res.status, wallMs, body };
}

export function proofDefaults(): ProofLimits {
  return { ...PROOF_LIMITS };
}
