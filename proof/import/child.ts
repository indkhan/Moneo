// E00-S03 isolated parser child.
//
// Runs one import parse inside a disposable Node process so corrupt,
// oversized or hostile inputs fail within bounds without compromising the
// parent. The parent enforces the upload size pre-check again here (defence
// in depth), the wall-clock deadline (by killing this process) and the
// process memory budget (via --max-old-space-size on the command line).
//
// Test-only hook: `hangMs` sleeps before parsing so the suite can prove the
// parent's timeout kill and recovery without waiting out the 60-second
// production deadline. It is documented in proof/import/README.md and never
// used outside tests.

import { readFileSync, statSync, writeFileSync } from "node:fs";

import {
  decideReimport,
  mergeLimits,
  parseImportFile,
  type ImportProfile,
  type PriorImport,
  type ProofLimits,
} from "./parser.ts";

type Job = {
  file: string;
  filename: string;
  profile: ImportProfile;
  limits?: Partial<ProofLimits>;
  prior?: { observationIds: string[]; keys: [string, string][] } | null;
  hangMs?: number;
  out: string;
};

function readJob(path: string): Job {
  return JSON.parse(readFileSync(path, "utf-8")) as Job;
}

function toPriorImport(job: Job["prior"]): PriorImport | null {
  if (!job) return null;
  return {
    observationIds: new Set(job.observationIds),
    keys: new Map(job.keys),
  };
}

const started = Date.now();

try {
  const jobPath = process.argv[process.argv.indexOf("--job") + 1];
  if (!jobPath) throw new Error("Missing --job <path> argument.");
  const job = readJob(jobPath);
  const lim = mergeLimits(job.limits);

  if (job.hangMs !== undefined && job.hangMs > 0) {
    const end = Date.now() + job.hangMs;
    while (Date.now() < end) {
      // Intentional busy wait for the timeout probe only.
    }
  }

  const stat = statSync(job.file);
  if (stat.size > lim.maxUploadBytes) {
    throw Object.assign(
      new Error(
        `File is ${stat.size} bytes; at most ${lim.maxUploadBytes} bytes are admitted. Split the statement or widen the limit explicitly.`,
      ),
      { code: "upload-limit" },
    );
  }
  const bytes = new Uint8Array(readFileSync(job.file));

  const parsed = parseImportFile(bytes, job.filename, job.profile, job.limits);
  let body: Record<string, unknown>;
  if (parsed.ok) {
    const prior = toPriorImport(job.prior ?? null);
    if (prior) {
      const { decisions, proposals } = decideReimport(parsed.proposals, prior);
      body = {
        ok: true,
        sheet: parsed.sheet,
        ignoredSheets: parsed.ignoredSheets,
        proposals,
        decisions,
      };
    } else {
      body = {
        ok: true,
        sheet: parsed.sheet,
        ignoredSheets: parsed.ignoredSheets,
        proposals: parsed.proposals,
      };
    }
  } else {
    body = { ok: false, error: parsed.error };
  }

  const mem = process.memoryUsage();
  writeFileSync(
    job.out,
    JSON.stringify({
      ...body,
      wallMs: Date.now() - started,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    }),
  );
  process.exit(0);
} catch (err) {
  const code =
    err !== null && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "internal";
  try {
    const jobPath = process.argv[process.argv.indexOf("--job") + 1];
    if (jobPath) {
      const job = readJob(jobPath);
      const mem = process.memoryUsage();
      writeFileSync(
        job.out,
        JSON.stringify({
          ok: false,
          error: { code, message: err instanceof Error ? err.message : String(err) },
          wallMs: Date.now() - started,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
        }),
      );
    }
  } catch {
    // Last resort: the out path itself is unusable.
  }
  process.exit(code === "internal" ? 3 : 2);
}
