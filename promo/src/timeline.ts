// One timeline for picture and sound, counted in beats at 140 BPM. Every shot is real footage from
// promo/demo: `src` is where it starts in the recording (seconds), `rate` how fast it plays.
// scripts/make-audio.mts reads the same tables to place hits, clicks and whooshes.
export const FPS = 60;
export const BPM = 140;
export const BEAT = 60 / BPM;

export type CamKey = { b: number; x: number; y: number; z: number; d?: number };
export type Clip = {
  shot: string; from: number; to: number; src: number; rate: number;
  cam?: { x: number; y: number; z: number; to?: { x: number; y: number; z: number } };
  say?: string; tag?: string; voice?: "you" | "moneo"; click?: number; phone?: boolean;
};
export type Scene = { word?: string; bg?: "lime" | "ai" | "fg"; clips: Clip[]; beats: number };

const secondsToBeats = (seconds: number) => seconds / BEAT;
const fit = (from: number, srcFrom: number, srcTo: number, rate: number) => ({ from, to: from + secondsToBeats((srcTo - srcFrom) / rate), src: srcFrom, rate });

// The call runs at the speed of the voices, slightly quickened, then pads out to a whole beat.
const VOICE = 1.15;
const CALL: Omit<Clip, "from" | "to" | "rate">[] = [
  { shot: "call", src: 7.1, voice: "you", cam: { x: 1210, y: 430, z: 1.9, to: { x: 1210, y: 430, z: 1.6 } } },
  { shot: "call", src: 9.2, voice: "you", cam: { x: 1210, y: 400, z: 1.25, to: { x: 1210, y: 420, z: 1.5 } } },
  { shot: "call", src: 14.8, voice: "you", cam: { x: 1240, y: 460, z: 1.15, to: { x: 1240, y: 460, z: 1.35 } } },
  { shot: "call", src: 20, tag: "Two things at once", cam: { x: 1210, y: 660, z: 1.9 } },
  { shot: "call", src: 27.2, voice: "moneo", cam: { x: 1210, y: 430, z: 2, to: { x: 1210, y: 430, z: 1.55 } } },
  { shot: "call", src: 43.1, voice: "moneo", cam: { x: 1210, y: 700, z: 1.5, to: { x: 1210, y: 860, z: 2.2 } } },
  { shot: "call", src: 51.2, tag: "Nothing is saved until you tap", cam: { x: 1210, y: 780, z: 1.9 }, click: 52.3 },
];
const CALL_ENDS = [8.95, 13.75, 19.6, 26.7, 31.35, 49.6, 55.6];
const CALL_RATES = [VOICE, VOICE, VOICE, 4, VOICE, VOICE, 2.2];
let callAt = 1;
const callClips: Clip[] = CALL.map((clip, index) => {
  const timed = fit(callAt, clip.src, CALL_ENDS[index], CALL_RATES[index]);
  callAt = timed.to;
  return { ...clip, ...timed };
});
const callBeats = Math.ceil(callAt);
callClips.at(-1)!.to = callBeats;

const tourStop = (from: number, shot: string, src: number, say: string, phone = false): Clip => ({ shot, from, to: from + 0.75, src, rate: 2, say, phone });

export const SCENES_DATA = {
  hook: { clips: [{ shot: "call", from: 6, to: 8, src: 0.72, rate: 1, cam: { x: 1700, y: 205, z: 1.6, to: { x: 1760, y: 205, z: 2.4 } }, click: 1.56 }], beats: 8 } as Scene,
  call: { word: "Call it.", bg: "lime", clips: callClips, beats: callBeats } as Scene,
  see: { word: "See it.", bg: "ai", beats: 8, clips: [
    { shot: "home", from: 1, to: 3, src: 0.4, rate: 1, cam: { x: 720, y: 830, z: 1.45, to: { x: 720, y: 860, z: 1.7 } }, say: "Everything you own." },
    { shot: "home", from: 3, to: 6, src: 3, rate: 6, cam: { x: 960, y: 540, z: 1.15 }, say: "On one screen." },
    { shot: "tour", from: 6, to: 8, src: 15.6, rate: 1.7, cam: { x: 960, y: 540, z: 1.15, to: { x: 960, y: 420, z: 1.3 } }, say: "Banks and Scalable, synced." },
  ] } as Scene,
  ask: { word: "Ask it.", bg: "lime", beats: 8, clips: [
    { shot: "chat", from: 1, to: 3.5, src: 1.3, rate: 2, cam: { x: 1152, y: 540, z: 1.9 } },
    { shot: "chat", from: 3.5, to: 8, src: 3.5, rate: 5.75, cam: { x: 1250, y: 520, z: 1.2, to: { x: 1250, y: 520, z: 1.35 } }, say: "Real answers from your records." },
  ] } as Scene,
  budget: { word: "Budget it.", bg: "fg", beats: 5, clips: [
    { shot: "budget", from: 1, to: 5, src: 0.4, rate: 3, cam: { x: 900, y: 560, z: 1.3, to: { x: 900, y: 620, z: 1.5 } }, say: "Limits that keep up on their own." },
  ] } as Scene,
  plan: { word: "Plan it.", bg: "ai", beats: 10, clips: [
    { shot: "plan", from: 1, to: 4, src: 0, rate: 3.3, cam: { x: 1100, y: 640, z: 1.35, to: { x: 1100, y: 640, z: 1.55 } }, say: "See the year ahead." },
    { shot: "plan", from: 4, to: 6, src: 5.4, rate: 2.2, cam: { x: 760, y: 640, z: 1.25 }, say: "Track the big goals." },
    { shot: "plan", from: 6, to: 10, src: 11, rate: 1.1, cam: { x: 1100, y: 640, z: 1.3, to: { x: 1200, y: 640, z: 1.6 } }, say: "Try Lisbon before you book." },
  ] } as Scene,
  build: { word: "Build it.", bg: "lime", beats: 22, clips: [
    { shot: "artifact", from: 1, to: 4, src: 1.3, rate: 3.2, cam: { x: 800, y: 480, z: 1.7 }, say: "Describe any tool." },
    { shot: "artifact", from: 4, to: 7.5, src: 6.6, rate: 50, cam: { x: 960, y: 540, z: 1.05 }, say: "Moneo builds it from your numbers.", tag: "Sped up" },
    { shot: "artifact", from: 7.5, to: 14.5, src: 91, rate: 1.27, cam: { x: 1400, y: 690, z: 1.5, to: { x: 1400, y: 700, z: 1.75 } }, say: "Drag it. It redoes the maths." },
    { shot: "artifact", from: 14.5, to: 17, src: 99, rate: 2, cam: { x: 1500, y: 300, z: 1.5 }, click: 100.1 },
    { shot: "homecard", from: 17, to: 22, src: 0.7, rate: 1.45, cam: { x: 700, y: 420, z: 1.55, to: { x: 700, y: 430, z: 1.75 } }, say: "Now it lives on your Home." },
  ] } as Scene,
  trade: { word: "Trade it.", bg: "ai", beats: 13, clips: [
    { shot: "trade", from: 1, to: 3, src: 1.7, rate: 1.9, cam: { x: 1152, y: 540, z: 1.9 } },
    { shot: "trade", from: 3, to: 4.5, src: 3.48, rate: 17, cam: { x: 1250, y: 540, z: 1.05 } },
    { shot: "trade", from: 4.5, to: 7, src: 14.45, rate: 4, cam: { x: 1290, y: 520, z: 1.45 }, say: "Scalable previews the order." },
    { shot: "trade", from: 7, to: 13, src: 19, rate: 1, cam: { x: 1000, y: 690, z: 1.85 }, say: "Only your tap sends it.", click: 19.93 },
  ] } as Scene,
  power: { word: "Power it.", bg: "fg", beats: 6, clips: [
    { shot: "settings", from: 1, to: 6, src: 0.3, rate: 0.9, cam: { x: 800, y: 470, z: 1.8, to: { x: 720, y: 500, z: 2.3 } }, say: "Use the ChatGPT plan you already have.", click: 1.78 },
  ] } as Scene,
  tour: { beats: 8, clips: [
    tourStop(0, "tour", 2.2, "Every transaction"), tourStop(0.75, "tour", 6.8, "Every account"), tourStop(1.5, "tour", 11.2, "Bills it finds for you"),
    tourStop(2.25, "tour", 16.2, "Your wealth"), tourStop(3, "tour", 20.3, "Import any statement"), tourStop(3.75, "tour", 23.5, "Clean up in bulk"),
    tourStop(4.5, "tour", 26.8, "Agents that review"), tourStop(5.25, "tour", 30, "A log of everything"), tourStop(6, "tour", 33.6, "Ctrl K, anywhere"),
    { shot: "phone", from: 6.75, to: 8, src: 0.5, rate: 3, say: "And on your phone", phone: true },
  ] } as Scene,
  own: { word: "Own it.", bg: "lime", clips: [], beats: 14 } as Scene,
};

export type SceneName = keyof typeof SCENES_DATA;
export const ORDER: SceneName[] = ["hook", "call", "see", "ask", "budget", "plan", "build", "trade", "power", "tour", "own"];

let at = 0;
export const STARTS = Object.fromEntries(ORDER.map(name => { const start = at; at += SCENES_DATA[name].beats; return [name, start]; })) as Record<SceneName, number>;
export const TOTAL_BEATS = at;

/** Where each sound lands, in beats from the start of the video. */
export const allClips = ORDER.flatMap(name => SCENES_DATA[name].clips.map(clip => ({ ...clip, scene: name, start: STARTS[name] + clip.from, end: STARTS[name] + clip.to })));
export const VOICE_WINDOWS = allClips.filter(clip => clip.voice).map(clip => [clip.start, clip.end] as const);
export const SLAMS = ORDER.filter(name => SCENES_DATA[name].word).map(name => STARTS[name]);
export const CUTS = allClips.map(clip => clip.start);
export const CLICKS = allClips.filter(clip => clip.click).map(clip => clip.start + (clip.click! - clip.src) / clip.rate / BEAT);
export const HOOK_WORDS = [0, 1, 2, 3, 4, 5];
export const OWN_WORDS = [1, 2, 3];
export const OWN_FINAL = 4;
