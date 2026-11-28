import { expect, it } from "vitest";
import { serialSave } from "./serial-save";

function controlled() {
  const calls: { value: Record<string, string>; finish: () => void }[] = [];
  const save = (value: Record<string, string>) => new Promise<void>(resolve => calls.push({ value, finish: resolve }));
  return { calls, save };
}

it("never runs two saves at once and sends every field changed while one was in flight", async () => {
  const state = { theme: "light", voice: "cedar" };
  const { calls, save } = controlled();
  const request = serialSave(() => ({ ...state }), save);
  const first = request();
  state.theme = "dark"; const second = request();
  state.voice = "marin"; request();
  expect(calls).toHaveLength(1);
  calls[0]?.finish();
  await Promise.resolve(); await Promise.resolve();
  expect(calls.map(call => call.value)).toEqual([{ theme: "light", voice: "cedar" }, { theme: "dark", voice: "marin" }]);
  calls[1]?.finish();
  await Promise.all([first, second]);
  request();
  expect(calls).toHaveLength(3);
});

it("keeps saving after a failed save", async () => {
  let fail = true;
  const sent: number[] = [];
  const request = serialSave(() => sent.length, async value => { sent.push(value); if (fail) throw new Error("offline"); });
  await expect(request()).rejects.toThrow("offline");
  fail = false;
  await request();
  expect(sent).toEqual([0, 1]);
});
