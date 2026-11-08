// Synthesizes the whole soundtrack from code, so the video carries no licensed music:
// a 140 BPM track shaped to the edit, plus hits, clicks and whooshes placed from src/timeline.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { BEAT, CLICKS, CUTS, HOOK_WORDS, OWN_FINAL, OWN_WORDS, SLAMS, STARTS, TOTAL_BEATS } from "../src/timeline.ts";

const RATE = 44100, LENGTH = Math.ceil((TOTAL_BEATS * BEAT + 0.5) * RATE);
const left = new Float32Array(LENGTH), right = new Float32Array(LENGTH);
const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);
const seconds = (beats: number) => beats * BEAT;
let seed = 7;
const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };

function add(at: number, length: number, make: (time: number) => number, gain = 1, pan = 0) {
  const start = Math.round(at * RATE), count = Math.round(length * RATE);
  for (let i = 0; i < count && start + i < LENGTH; i++) {
    if (start + i < 0) continue;
    const value = make(i / RATE) * gain;
    left[start + i] += value * (1 - Math.max(0, pan));
    right[start + i] += value * (1 + Math.min(0, pan));
  }
}

const kick = (at: number, gain: number) => add(at, 0.26, time => Math.tanh(2.2 * Math.sin(2 * Math.PI * (52 * time + 26 * (1 - Math.exp(-time * 34))))) * Math.exp(-time * 11), gain);
const hat = (at: number, gain: number, pan: number, decay = 80) => { let last = 0; add(at, 0.06, time => { const n = noise(), high = n - last; last = n; return high * Math.exp(-time * decay); }, gain, pan); };
const clap = (at: number, gain: number) => { let lp = 0; add(at, 0.16, time => { const n = noise(); lp += (n - lp) * 0.5; return (n - lp) * Math.exp(-time * 26); }, gain); };
const saw = (phase: number) => 2 * (phase - Math.floor(phase + 0.5));
const bass = (at: number, note: number, gain: number) => { let lp = 0; add(at, BEAT * 0.24, time => { const f = midi(note); lp += (saw(f * time) + Math.sin(2 * Math.PI * f * time) - lp) * 0.16; return lp * Math.min(1, time * 300) * Math.exp(-time * 4); }, gain); };
function pluck(at: number, note: number, gain: number, pan: number) {
  let lp = 0;
  add(at, 0.32, time => { lp += (saw(midi(note) * time) * 0.7 + saw(midi(note) * 1.005 * time) * 0.3 - lp) * (0.05 + 0.55 * Math.exp(-time * 18)); return lp * Math.min(1, time * 500) * Math.exp(-time * 10); }, gain, pan);
}
function stab(at: number, notes: number[], gain: number) {
  notes.forEach((note, voice) => { let lp = 0; add(at, 0.2, time => { lp += (saw(midi(note) * time) + saw(midi(note) * 1.007 * time) - lp) * (0.08 + 0.3 * Math.exp(-time * 22)); return lp * Math.min(1, time * 500) * Math.exp(-time * 13); }, gain, voice % 2 ? 0.4 : -0.4); });
}
function pad(at: number, length: number, notes: number[], gain: number) {
  notes.forEach((note, voice) => {
    let lp = 0;
    add(at, length + 0.1, time => {
      const f = midi(note);
      lp += (saw(f * time) + saw(f * 1.006 * time) - lp) * 0.035;
      return lp * Math.min(1, time * 6, (length + 0.1 - time) * 8);
    }, gain, voice % 2 ? 0.35 : -0.35);
  });
}
function riser(end: number, length: number, gain: number) {
  let lp = 0;
  add(end - length, length, time => { const p = time / length; lp += (noise() - lp) * (0.01 + p * p * 0.6); return lp * p * p; }, gain);
}
const snareRoll = (end: number, beats: number, gain: number) => { for (let step = 0; step < beats * 4; step++) { const p = step / (beats * 4); clap(end - seconds(beats) + seconds(step / 4), gain * (0.3 + p * 0.7)); } };
const whoosh = (at: number, gain: number) => { let lp = 0; add(at, 0.3, time => { const p = time / 0.3, shape = Math.sin(Math.PI * p); lp += (noise() - lp) * (0.04 + shape * 0.25); return lp * shape; }, gain, 0); };
const hit = (at: number, gain: number) => {
  add(at, 0.55, time => Math.tanh(2 * Math.sin(2 * Math.PI * (36 * time + 16 * (1 - Math.exp(-time * 24))))) * Math.exp(-time * 6.5), gain);
  let lp = 0; add(at, 0.13, time => { const n = noise(); lp += (n - lp) * 0.45; return lp * Math.exp(-time * 28); }, gain * 0.5);
};
const click = (at: number, gain = 0.5) => add(at, 0.03, time => (Math.sin(2 * Math.PI * 2200 * time) + noise() * 0.4) * Math.exp(-time * 190), gain);
function chime(at: number, gain = 0.2) {
  [84, 91].forEach((note, index) => add(at + index * 0.06, 0.55, time => (Math.sin(2 * Math.PI * midi(note) * time) + 0.3 * Math.sin(4 * Math.PI * midi(note) * time)) * Math.exp(-time * 7), gain));
}

// Am F C G, one bar each.
const CHORDS = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]];
const ROOTS = [33, 29, 36, 31];
const END = STARTS.own + OWN_FINAL;
// A tense intro, a groove under the call, the full track from the first feature on, and a lift for the wall of features.
const section = (beat: number) => {
  if (beat < STARTS.call) return { kick: 0, bass: 0, hat: beat >= 3 ? 0.4 : 0, clap: 0, arp: beat >= 3 ? 0.7 : 0.3, pad: 0.8, stab: 0 };
  if (beat < STARTS.see) return { kick: 0.7, bass: 0.7, hat: 0.5, clap: 0.3, arp: 0.6, pad: 0.8, stab: 0 };
  if (beat < STARTS.trade) return { kick: 1, bass: 1, hat: 1, clap: 1, arp: 1, pad: 0.7, stab: 1 };
  if (beat < STARTS.tour) return { kick: 1, bass: 0.7, hat: 0.7, clap: 0.4, arp: 1, pad: 1, stab: 0.5 };
  if (beat < END) return { kick: 1, bass: 1, hat: 1.3, clap: 1, arp: 1.1, pad: 0.8, stab: 1.1 };
  return { kick: 0, bass: 0, hat: 0, clap: 0, arp: 0, pad: 0, stab: 0 };
};

const pulses: number[] = [];
for (let bar = 0; bar * 4 < END; bar++) {
  const barBeat = bar * 4, chord = CHORDS[bar % 4], root = ROOTS[bar % 4];
  for (let beat = 0; beat < 4; beat++) { const s = section(barBeat + beat); if (s.pad && barBeat + beat < END) pad(seconds(barBeat + beat), BEAT, chord, 0.017 * s.pad); }
  for (let step = 0; step < 16; step++) {
    const beat = barBeat + step / 4, at = seconds(beat), s = section(beat);
    if (beat >= END) break;
    if (step % 4 === 0 && s.kick) { kick(at, 0.62 * s.kick); pulses.push(at); }
    if (step % 8 === 4 && s.clap) clap(at, 0.2 * s.clap);
    if (step % 4 === 2 && s.hat) hat(at, 0.15 * s.hat, step % 8 === 2 ? -0.2 : 0.2);
    if (step % 2 === 1 && s.hat) hat(at, 0.05 * s.hat, 0.3);
    if (step % 4 !== 0 && s.bass) bass(at, root + (step % 8 === 6 ? 12 : 0), 0.26 * s.bass);
    if ([3, 6, 11, 14].includes(step) && s.stab) stab(at, chord.map(note => note + 12), 0.03 * s.stab);
    if (s.arp) {
      const pattern = [0, 2, 3, 1, 2, 3, 1, 3], note = chord[pattern[step % 8]] + 12;
      const pan = step % 2 ? 0.35 : -0.35;
      pluck(at, note, 0.05 * s.arp, pan);
      pluck(at + seconds(0.75), note, 0.014 * s.arp, -pan); // a dotted-eighth echo
    }
  }
}
// Duck everything but the kick under each kick, for the pump.
const envelope = new Float32Array(LENGTH).fill(1);
for (const at of pulses) {
  const first = Math.round(at * RATE);
  for (let i = 0; i < RATE * BEAT && first + i < LENGTH; i++) envelope[first + i] = Math.min(envelope[first + i], 0.4 + 0.6 * Math.min(1, i / (RATE * BEAT * 0.8)));
}
for (let i = 0; i < LENGTH; i++) { left[i] *= envelope[i]; right[i] *= envelope[i]; }

// Moments of the edit, placed after the ducking so they cut through.
HOOK_WORDS.forEach((beat, index) => hit(seconds(beat), index === 4 ? 0.9 : 0.4));
for (const beat of [0.42, 1.42, 2.42]) click(seconds(beat), 0.5);
riser(seconds(STARTS.call), seconds(3), 0.5);
snareRoll(seconds(STARTS.call), 2, 0.15);
for (const beat of SLAMS) { hit(seconds(beat), 0.72); whoosh(seconds(beat) - 0.14, 0.3); }
for (const beat of CUTS) whoosh(seconds(beat) - 0.1, 0.16);
for (const beat of CLICKS) { click(seconds(beat), 0.6); chime(seconds(beat) + 0.02); hit(seconds(beat), 0.3); }
riser(seconds(STARTS.tour), seconds(4), 0.42);
snareRoll(seconds(STARTS.tour), 2, 0.15);
hit(seconds(STARTS.tour), 0.75);
OWN_WORDS.forEach(beat => hit(seconds(STARTS.own + beat), 0.5));

// The ending: one held chord that rings out over the logo.
const finale = seconds(END);
hit(finale, 0.85);
pad(finale, seconds(10), [48, 55, 60, 62, 64, 67, 72], 0.026);
[72, 76, 79, 84].forEach((note, index) => add(finale + seconds(index * 0.25), 3.2, time => Math.sin(2 * Math.PI * midi(note) * time) * Math.exp(-time * 1.5), 0.08, index % 2 ? 0.3 : -0.3));

// Soft-clip, fade the tail and write 16-bit stereo.
const data = Buffer.alloc(LENGTH * 4);
for (let i = 0; i < LENGTH; i++) {
  const fade = Math.min(1, (LENGTH - i) / (RATE * 1.2));
  data.writeInt16LE(Math.round(Math.tanh(left[i] * 1.15) * fade * 30000), i * 4);
  data.writeInt16LE(Math.round(Math.tanh(right[i] * 1.15) * fade * 30000), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 4, 28);
header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
mkdirSync("public", { recursive: true });
writeFileSync("public/moneo-promo-track.wav", Buffer.concat([header, data]));
console.log(`Wrote public/moneo-promo-track.wav, ${(LENGTH / RATE).toFixed(1)}s`);
