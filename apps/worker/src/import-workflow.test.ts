import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import { classifyError, createRetryDecider, isRetryableClass, transientError } from "./retry.js";
import {
  JobCancelledError,
  runDurableJob,
  type DurableJob,
  type HandlerContext,
  type JobHandler,
  type JobStore,
} from "./job-lifecycle.js";
import {
  createImportHandlers,
  createMemoryImportStore,
  IMPORT_JOB_TYPE,
  IMPORT_STAGES,
  parseImportInput,
  runImportWorkflow,
  type ImportJobInput,
  type ImportStore,
} from "./import-workflow.js";

/**
 * Issue 3.6 — durable statement import workflow.
 *
 * Proves, in order: stage order and the summary invariant
 * (new + duplicate + error = rowCount); batching (progress, heartbeats,
 * bounded memory per batch); malformed and unmappable rows counted while
 * good rows land; identical legitimate rows staying distinct; formula cells
 * arriving with cached (never computed) values; crash-and-retry resuming
 * without duplication; the full Epoch 2 lifecycle integration (retry then
 * success, duplicate delivery inert); cancellation before/during the run
 * (partial source rows preserved, never a summary); failure classes
 * (missing bytes transient, bad file/mapping/payload permanent); payload
 * validation; and the empty-file edge.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const DS = "22222222-2222-4222-8222-222222222222";
const IMP = "33333333-3333-4333-8333-333333333333";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const CSV_MAPPING = {
  date: 0,
  description: 1,
  amount: 2,
  credit: null,
  debit: null,
  currency: null,
  direction: null,
  account: null,
};

function csvInput(overrides: Partial<ImportJobInput> = {}): ImportJobInput {
  return {
    importId: IMP,
    workspaceId: WS,
    dataSourceId: DS,
    objectKey: "quarantine/key/statement.csv",
    fileName: "statement.csv",
    mapping: { ...CSV_MAPPING },
    ...overrides,
  };
}

function liveCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    jobId: "job-1",
    workspaceId: WS,
    attemptNumber: 1,
    workerId: "worker-1",
    heartbeat: () => Promise.resolve(),
    isCancelled: () => Promise.resolve(false),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Minimal stored-only ZIP writer for the .xlsx path (no deflate needed).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function storedZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const push = (target: Uint8Array[], part: Uint8Array): void => {
    target.push(part);
  };
  const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const header = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc32(entry.data)),
      u32(entry.data.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    push(locals, header);
    push(locals, entry.data);
    push(
      centrals,
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc32(entry.data)),
        u32(entry.data.length),
        u32(entry.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += header.length + entry.data.length;
  }
  const localBlock = concat(locals);
  const cd = concat(centrals);
  return concat([
    localBlock,
    cd,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(localBlock.length),
    u16(0),
  ]);
}

function xlsxBytes(): Uint8Array {
  const sheet =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>2</v></c></row>` +
    // =1+1 cached as 7: arriving as 7 proves the workflow never evaluates.
    `<row r="2"><c r="A2"><v>44927</v></c><c r="B2" t="s"><v>0</v></c><c r="C2"><f>1+1</f><v>7</v></c></row>` +
    `</sheetData></worksheet>`;
  return storedZip([
    {
      name: "[Content_Types].xml",
      data: bytesOf(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: bytesOf(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<sheets><sheet name="Stmt" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: bytesOf(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "xl/sharedStrings.xml",
      data: bytesOf(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">` +
          `<si><t>date</t></si><si><t>note</t></si></sst>`,
      ),
    },
    { name: "xl/worksheets/sheet1.xml", data: bytesOf(sheet) },
  ]);
}

// ---------------------------------------------------------------------------
// Compact durable-job store for lifecycle integration.
// ---------------------------------------------------------------------------

function memoryJobStore(jobs: DurableJob[]) {
  const rows = new Map(jobs.map((j) => [j.id, { ...j }]));
  const store: JobStore = {
    load: (jobId) => Promise.resolve(rows.get(jobId) ? { ...rows.get(jobId)! } : null),
    createAttempt: () => Promise.resolve(),
    markRunning: (jobId, _worker, _n) => {
      rows.get(jobId)!.status = "running";
      return Promise.resolve();
    },
    heartbeat: () => Promise.resolve(),
    finishAttempt: () => Promise.resolve(),
    markSucceeded: (jobId) => {
      rows.get(jobId)!.status = "succeeded";
      return Promise.resolve();
    },
    markRetryable: (jobId, attempts) => {
      rows.get(jobId)!.status = "queued";
      rows.get(jobId)!.attempts = attempts;
      return Promise.resolve();
    },
    markFailed: (jobId, attempts) => {
      rows.get(jobId)!.status = "failed";
      rows.get(jobId)!.attempts = attempts;
      return Promise.resolve();
    },
    markCancelled: (jobId, attempts) => {
      rows.get(jobId)!.status = "cancelled";
      rows.get(jobId)!.attempts = attempts;
      return Promise.resolve();
    },
  };
  return { store, rows };
}

describe("stage order and summary", () => {
  it("runs every stage in contract order with an exact summary", async () => {
    const store = createMemoryImportStore({
      objects: {
        "quarantine/key/statement.csv": bytesOf(
          "date,desc,amount\n2026-01-01,coffee,-3.50\n2026-01-02,salary,2500.00\n2026-01-03,tea,1.25\n",
        ),
      },
    });
    const summary = await runImportWorkflow(store, csvInput(), liveCtx());
    expect(store.stages(IMP)).toEqual([
      "FILE_VALIDATION",
      "PARSE",
      "PARSE",
      "SOURCE_ACCOUNT_DETECTION",
      "SOURCE_TRANSACTION_UPSERT",
      "SOURCE_TRANSACTION_UPSERT",
      "IMPORT_SUMMARY",
    ]);
    expect(summary).toEqual({
      rowCount: 3,
      newCount: 3,
      duplicateCount: 0,
      reviewCount: 0,
      errorCount: 0,
      sourceAccountId: summary.sourceAccountId,
    });
    // new + duplicate + error always equals rowCount.
    expect(summary.newCount + summary.duplicateCount + summary.errorCount).toBe(summary.rowCount);
    expect(store.status(IMP)).toBe("succeeded");
    expect(store.summary(IMP)).toEqual(summary);
    expect(store.transactions()).toHaveLength(3);
    expect(store.observations()).toHaveLength(3);
  });

  it("derives the account label from the file stem unless the wizard chose one", async () => {
    const store = createMemoryImportStore({
      objects: { "quarantine/key/statement.csv": bytesOf("date,desc,amount\n2026-01-01,x,1.00\n") },
    });
    const first = await runImportWorkflow(store, csvInput(), liveCtx());
    // Same label + same source re-import shares the account (upsert, not new).
    const second = await runImportWorkflow(
      store,
      csvInput({ importId: "44444444-4444-4444-8444-444444444444" }),
      liveCtx(),
    );
    expect(second.sourceAccountId).toBe(first.sourceAccountId);
    // A wizard-chosen label maps to its own account in the same source.
    const named = await runImportWorkflow(
      store,
      csvInput({
        importId: "55555555-5555-4555-8555-555555555555",
        accountName: "  Holiday fund  ",
      }),
      liveCtx(),
    );
    expect(named.sourceAccountId).not.toBe(first.sourceAccountId);
  });

  it("exposes the stage contract in order", () => {
    expect(IMPORT_STAGES).toEqual([
      "FILE_VALIDATION",
      "PARSE",
      "SOURCE_ACCOUNT_DETECTION",
      "SOURCE_TRANSACTION_UPSERT",
      "IMPORT_SUMMARY",
    ]);
    expect(IMPORT_JOB_TYPE).toBe("import.process");
  });
});

describe("batching", () => {
  it("processes bounded batches with heartbeats and progress", async () => {
    const lines = ["date,desc,amount"];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(`2026-01-0${i},row${i},${i}.00`);
    }
    const store = createMemoryImportStore({
      objects: { "quarantine/key/statement.csv": bytesOf(`${lines.join("\n")}\n`) },
    });
    let heartbeats = 0;
    const seen: number[] = [];
    const tracking: ImportStore = {
      ...store,
      setImportStage: (id, stage, patch) => {
        if (stage === "SOURCE_TRANSACTION_UPSERT" && patch?.progressPercent !== undefined) {
          seen.push(patch.progressPercent);
        }
        return store.setImportStage(id, stage, patch);
      },
    };
    const summary = await runImportWorkflow(
      tracking,
      csvInput({ batchSize: 2 }),
      liveCtx({
        heartbeat: () => {
          heartbeats += 1;
          return Promise.resolve();
        },
      }),
    );
    expect(summary).toMatchObject({ rowCount: 5, newCount: 5, errorCount: 0 });
    expect(seen).toEqual([33, 66, 100]);
    expect(heartbeats).toBe(3);
  });
});

describe("row-level failures", () => {
  it("counts malformed and unmappable rows while keeping the good ones", async () => {
    const store = createMemoryImportStore({
      objects: {
        "quarantine/key/statement.csv": bytesOf(
          "date,desc,amount\n2026-01-01,ok,10.00\n2026-01-02,short\nnot-a-date,bad,5.00\n2026-01-04,also-ok,2.50\n",
        ),
      },
    });
    const summary = await runImportWorkflow(store, csvInput(), liveCtx());
    // 1 parser shape error + 1 mapping date error; 2 rows land.
    expect(summary).toMatchObject({ rowCount: 4, newCount: 2, errorCount: 2 });
    expect(store.transactions()).toHaveLength(2);
    expect(
      store
        .observations()
        .map((o) => o.rowNumber)
        .sort(),
    ).toEqual([2, 5]);
  });

  it("keeps two legitimate identical purchases distinct", async () => {
    const store = createMemoryImportStore({
      objects: {
        "quarantine/key/statement.csv": bytesOf(
          "date,desc,amount\n2026-02-01,COFFEE BAR,3.50\n2026-02-01,COFFEE BAR,3.50\n",
        ),
      },
    });
    const summary = await runImportWorkflow(store, csvInput(), liveCtx());
    expect(summary).toMatchObject({ rowCount: 2, newCount: 2, duplicateCount: 0 });
    const ids = store.transactions().map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("imports formula cells with cached values through the workflow", async () => {
    const store = createMemoryImportStore({
      objects: { "quarantine/key/sheet.xlsx": xlsxBytes() },
    });
    const summary = await runImportWorkflow(
      store,
      csvInput({
        objectKey: "quarantine/key/sheet.xlsx",
        fileName: "sheet.xlsx",
      }),
      liveCtx(),
    );
    expect(summary).toMatchObject({ rowCount: 1, newCount: 1, errorCount: 0 });
    expect(store.transactions()).toHaveLength(1);
  });
});

describe("crash recovery without duplication", () => {
  it("resumes mid-batch: replayed rows count as duplicates, never as new", async () => {
    const objects = {
      "quarantine/key/statement.csv": bytesOf(
        "date,desc,amount\n2026-01-01,a,1.00\n2026-01-02,b,2.00\n2026-01-03,c,3.00\n",
      ),
    };
    const store = createMemoryImportStore({ objects });
    let calls = 0;
    const crashing: ImportStore = {
      ...store,
      recordObservation: (input) => {
        calls += 1;
        if (calls === 2) {
          throw transientError("worker lost power");
        }
        return store.recordObservation(input);
      },
    };
    await expect(runImportWorkflow(crashing, csvInput(), liveCtx())).rejects.toThrow(
      "worker lost power",
    );
    // Attempt 1 persisted: txn a + obs a, txn b (obs b crashed). Nothing summarized.
    expect(store.status(IMP)).toBe("running");
    expect(store.summary(IMP)).toBeUndefined();

    const summary = await runImportWorkflow(store, csvInput(), liveCtx());
    expect(summary).toMatchObject({ rowCount: 3, newCount: 1, duplicateCount: 2, errorCount: 0 });
    expect(store.transactions()).toHaveLength(3);
    expect(store.observations()).toHaveLength(3);
    expect(store.status(IMP)).toBe("succeeded");
  });

  it("integrates with the Epoch 2 lifecycle: retry, then success, then inert redelivery", async () => {
    const store = createMemoryImportStore({
      objects: {
        "quarantine/key/statement.csv": bytesOf("date,desc,amount\n2026-01-01,a,1.00\n"),
      },
    });
    let attempts = 0;
    const flaky: ImportStore = {
      ...store,
      getObject: (key) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.resolve(null); // bytes not visible yet → TRANSIENT
        }
        return store.getObject(key);
      },
    };
    const handlers = createImportHandlers(flaky);
    const { store: jobs, rows } = memoryJobStore([
      {
        id: "job-1",
        workspaceId: WS,
        type: IMPORT_JOB_TYPE,
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        payload: {
          importId: IMP,
          workspaceId: WS,
          dataSourceId: DS,
          objectKey: "quarantine/key/statement.csv",
          fileName: "statement.csv",
          mapping: { ...CSV_MAPPING },
        },
      } satisfies DurableJob,
    ]);
    const decideRetry = createRetryDecider();
    const first = await runDurableJob(jobs, handlers, decideRetry, "job-1", "worker-1");
    expect(first).toMatchObject({ status: "failed", retried: true });
    expect(rows.get("job-1")?.status).toBe("queued");

    const second = await runDurableJob(jobs, handlers, decideRetry, "job-1", "worker-1");
    expect(second).toMatchObject({ status: "succeeded" });
    expect(store.summary(IMP)).toMatchObject({ rowCount: 1, newCount: 1 });

    // Duplicate delivery of finished work: inert, no second import effect.
    const third = await runDurableJob(jobs, handlers, decideRetry, "job-1", "worker-1");
    expect(third).toMatchObject({ status: "skipped", reason: "terminal" });
    expect(store.transactions()).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("aborts before any effect when already cancelled", async () => {
    const store = createMemoryImportStore({
      objects: { "quarantine/key/statement.csv": bytesOf("date,desc,amount\n2026-01-01,a,1.00\n") },
    });
    await expect(
      runImportWorkflow(store, csvInput(), liveCtx({ isCancelled: () => Promise.resolve(true) })),
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(store.status(IMP)).toBe("cancelled");
    expect(store.summary(IMP)).toBeUndefined();
    expect(store.transactions()).toHaveLength(0);
  });

  it("stops between batches, preserving partial source rows without a summary", async () => {
    const store = createMemoryImportStore({
      objects: {
        "quarantine/key/statement.csv": bytesOf(
          "date,desc,amount\n2026-01-01,a,1.00\n2026-01-02,b,2.00\n2026-01-03,c,3.00\n",
        ),
      },
    });
    let batches = 0;
    const cancelling = liveCtx({
      isCancelled: () => Promise.resolve(batches >= 1),
      heartbeat: () => {
        batches += 1;
        return Promise.resolve();
      },
    });
    await expect(
      runImportWorkflow(store, csvInput({ batchSize: 1 }), cancelling),
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(store.status(IMP)).toBe("cancelled");
    expect(store.summary(IMP)).toBeUndefined();
    // Batch 1 landed and stays (raw history is never rolled back); the rest never ran.
    expect(store.transactions()).toHaveLength(1);
    expect(store.observations()).toHaveLength(1);
  });
});

describe("failure classes", () => {
  it("treats missing bytes as transient (retryable)", async () => {
    const store = createMemoryImportStore({ objects: {} });
    const error = await runImportWorkflow(store, csvInput(), liveCtx()).catch((e: unknown) => e);
    expect(classifyError(error)).toBe("TRANSIENT");
    expect(isRetryableClass(classifyError(error))).toBe(true);
  });

  it("treats bad files, mappings, and payloads as permanent input", async () => {
    const textStore = (text: string): ImportStore =>
      createMemoryImportStore({ objects: { "quarantine/key/statement.csv": bytesOf(text) } });

    // Unsupported extension fails before parsing.
    const badExt = await runImportWorkflow(
      textStore("x"),
      csvInput({ fileName: "statement.pdf" }),
      liveCtx(),
    ).catch((e: unknown) => e);
    expect(badExt).toBeInstanceOf(DomainError);
    expect(classifyError(badExt)).toBe("PERMANENT_INPUT");

    // Structurally broken CSV fails the import fast.
    const broken = await runImportWorkflow(
      textStore('date,desc,amount\n"unterminated,1.00\n'),
      csvInput(),
      liveCtx(),
    ).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(DomainError);
    expect(classifyError(broken)).toBe("PERMANENT_INPUT");

    // A mapping that fits no header fails fast too.
    const badMapping = await runImportWorkflow(
      textStore("date,desc,amount\n2026-01-01,a,1.00\n"),
      csvInput({ mapping: { ...CSV_MAPPING, date: 9 } }),
      liveCtx(),
    ).catch((e: unknown) => e);
    expect(badMapping).toBeInstanceOf(DomainError);
    expect(classifyError(badMapping)).toBe("PERMANENT_INPUT");

    // Payloads are validated before any stage runs.
    expect(() => parseImportInput({})).toThrow(DomainError);
    expect(() => parseImportInput({ importId: IMP, batchSize: 0 })).toThrow(DomainError);
  });

  it("marks failed imports with the failure", async () => {
    const store = createMemoryImportStore({
      objects: { "quarantine/key/statement.csv": bytesOf("x") },
    });
    await expect(
      runImportWorkflow(store, csvInput({ fileName: "statement.pdf" }), liveCtx()),
    ).rejects.toThrow(DomainError);
    expect(store.status(IMP)).toBe("failed");
  });
});

describe("edges", () => {
  it("succeeds empty (header-only) files with zero counts", async () => {
    const store = createMemoryImportStore({
      objects: { "quarantine/key/statement.csv": bytesOf("date,desc,amount\n") },
    });
    const summary = await runImportWorkflow(store, csvInput(), liveCtx());
    expect(summary).toMatchObject({ rowCount: 0, newCount: 0, duplicateCount: 0, errorCount: 0 });
    expect(store.status(IMP)).toBe("succeeded");
  });

  it("exposes the handler under the import job type", () => {
    const handlers: Map<string, JobHandler> = createImportHandlers(createMemoryImportStore());
    expect(handlers.has(IMPORT_JOB_TYPE)).toBe(true);
  });
});
