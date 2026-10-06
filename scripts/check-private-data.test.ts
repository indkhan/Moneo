import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/check-private-data.mjs");

describe("private financial input gate", () => {
  it.each(["synthetic-private.csv", "nested/SYNTHETIC.XLSX", ".private-inputs/statement.txt", ".private-evidence/acceptance.txt", ".qa/log.txt"])("rejects prohibited index paths without disclosing paths or contents (%s)", (inputPath) => {
    const directory = mkdtempSync(join(tmpdir(), "moneo-privacy-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: directory });
      mkdirSync(dirname(join(directory, inputPath)), { recursive: true });
      writeFileSync(join(directory, inputPath), "Date,Payee,Account,Amount\n2026-01-01,SYNTHETIC_PERSON,DE89370400440532013000,-1.00\n");
      execFileSync("git", ["add", "."], { cwd: directory });
      let output = "";
      let failed = false;
      try { execFileSync(process.execPath, [script], { cwd: directory, encoding: "utf8", stdio: "pipe" }); }
      catch (error) {
        failed = true;
        output = String((error as { stderr: string }).stderr);
      }
      expect(failed).toBe(true);
      expect(output).toBe("Private financial input gate: remove tracked financial exports; use ignored private inputs or inline synthetic fixtures.\n");
      execFileSync("git", ["rm", "--cached", "--quiet", inputPath], { cwd: directory });
      writeFileSync(join(directory, "source.ts"), "export const amount = 100;\n");
      execFileSync("git", ["add", "source.ts"], { cwd: directory });
      expect(execFileSync(process.execPath, [script], { cwd: directory, encoding: "utf8" })).toBe("");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
