// One timeline for picture and sound, counted in beats at 140 BPM, so every cut lands on the music.
// scripts/make-audio.mts reads this file to place hits, clicks and whooshes.
export const FPS = 60;
export const BPM = 140;
export const BEAT = 60 / BPM;

export const SCENES = {
  hook: { start: 0, beats: 10 },
  call: { start: 10, beats: 14 },
  see: { start: 24, beats: 10 },
  budget: { start: 34, beats: 8 },
  plan: { start: 42, beats: 10 },
  build: { start: 52, beats: 16 },
  trade: { start: 68, beats: 8 },
  power: { start: 76, beats: 8 },
  everything: { start: 84, beats: 8 },
  own: { start: 92, beats: 14 },
} as const;

export const TOTAL_BEATS = SCENES.own.start + SCENES.own.beats;

export type CamKey = { b: number; x: number; y: number; z: number; d?: number };

// Camera moves inside a scene, in scene beats. Each move starts on its beat and gets a whoosh.
export const CAMS = {
  see: [
    { b: 0, x: 620, y: 300, z: 2 },
    { b: 2.75, x: 560, y: 830, z: 2 },
    { b: 4, x: 1470, y: 330, z: 2.1 },
    { b: 5.5, x: 960, y: 540, z: 1, d: 0.75 },
  ],
  build: [
    { b: 0, x: 480, y: 330, z: 2.2 },
    { b: 5, x: 480, y: 460, z: 2.6, d: 0.4 },
    { b: 6, x: 1420, y: 330, z: 2.2, d: 0.4 },
    { b: 7, x: 960, y: 800, z: 1.7, d: 0.4 },
    { b: 8, x: 960, y: 540, z: 1, d: 0.5 },
  ],
  trade: [
    { b: 0, x: 960, y: 480, z: 1 },
    { b: 2.5, x: 960, y: 590, z: 1.75, d: 0.4 },
    { b: 4, x: 520, y: 790, z: 2.3, d: 0.4 },
    { b: 5.5, x: 960, y: 540, z: 1, d: 0.5 },
  ],
  everything: [],
} satisfies Record<string, CamKey[]>;

// Beats inside each scene, shared with the audio so a click lands with its sound.
export const CUES = {
  hookWords: [0, 1, 2, 3, 4, 5, 6],
  hookRings: [7, 8],
  hookAnswer: 9.5,
  callYes: 8,
  callAmount: 9,
  callSave: 11.5,
  budgetBars: [1, 2, 3, 4],
  budgetAdd: 5.5,
  planLift: 6.5,
  buildTyped: 3.5,
  buildSlider: 9.25,
  buildHome: 14,
  tradeBuy: 5,
  powerSignIn: 2.5,
  everythingStep: 0.5,
  everythingTiles: 12,
  ownWords: [0, 1, 2, 3],
  ownFinal: 4,
};

// Scenes that open on a full-screen word.
export const SLAM_SCENES = ["call", "see", "budget", "plan", "build", "trade", "power"] as const;
