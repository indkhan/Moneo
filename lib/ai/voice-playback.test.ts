import { expect, it } from "vitest";
import { VoicePlayback } from "./voice-playback";

it("ducks noise, stops on words, and releases at the remote quiet boundary", () => {
  const gate = new VoicePlayback();
  expect(gate.volume(100, true, true)).toBe(0.2);
  gate.transcript("yeah");
  expect(gate.volume(1200, false, true)).toBe(1);
  gate.volume(1300, true, true);
  gate.transcript("wait");
  expect(gate.volume(1400, false, true)).toBe(0);
  gate.volume(1500, false, false);
  expect(gate.volume(2000, false, false)).toBe(1);
});
