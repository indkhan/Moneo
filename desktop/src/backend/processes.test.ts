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

it("starts file storage a second time when the first start fails, and reports a second failure", async () => {
  const { startWithOneRetry } = await import("./processes");
  const flaky = vi.fn().mockRejectedValueOnce(new Error("Storage API stopped while starting")).mockResolvedValueOnce(undefined);
  const retried = vi.fn(async () => {});
  await startWithOneRetry(flaky, retried);
  expect(flaky).toHaveBeenCalledTimes(2);
  expect(retried).toHaveBeenCalledWith(new Error("Storage API stopped while starting"));

  const broken = vi.fn().mockRejectedValue(new Error("still down"));
  await expect(startWithOneRetry(broken, async () => {})).rejects.toThrow("still down");
  expect(broken).toHaveBeenCalledTimes(2);
});
