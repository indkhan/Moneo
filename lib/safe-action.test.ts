import { expect, it, vi } from "vitest";
import { z } from "zod";
import { safely } from "./safe-action";

vi.mock("@/lib/ai/agent-apply", () => ({ readableError: (cause: unknown) => cause instanceof Error ? cause.message : "Could not save" }));

const form = new FormData();

it("returns nothing to show after a save", async () => {
  expect(await safely(form, async () => "saved")).toEqual({});
});

it("turns validation and refusals into a message for the form", async () => {
  const invalid = z.object({ name: z.string().min(1, "Enter a name") }).safeParse({ name: "" });
  expect(await safely(form, async () => { throw invalid.error; })).toEqual({ error: "Enter a name" });
  expect(await safely(form, async () => { throw new Error("Account not found"); })).toEqual({ error: "Account not found" });
});

it("lets a redirect through", async () => {
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/plan;307;" });
  await expect(safely(form, async () => { throw redirect; })).rejects.toBe(redirect);
});
