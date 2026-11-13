import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), fork: vi.fn() }));

it("keeps version output delivered after process exit (PR #206 Intel Mac relaunch)", async () => {
  const { spawn } = await import("node:child_process");
  const { runProgram } = await import("./processes");
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as never);
  const result = runProgram("postgres", ["--version"], { waitForClose: true });
  child.emit("exit", 0);
  child.stdout.write("postgres (PostgreSQL) 17.11\n");
  child.emit("close", 0);
  expect(await result).toEqual({ code: 0, output: "postgres (PostgreSQL) 17.11\n" });
});
