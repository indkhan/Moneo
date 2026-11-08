import type { CSSProperties, ReactNode } from "react";
import { Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadDisplay } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadSans } from "@remotion/google-fonts/Geist";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import rec from "./rec.json";
import words from "./call-words.json";
import { BEAT, type Clip } from "./timeline";

const display = loadDisplay("normal", { weights: ["500", "600", "700"], subsets: ["latin"] }).fontFamily;
const sans = loadSans("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;
const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

export const font = { display, sans, mono };

// Moneo's dark theme, copied from app/globals.css.
export const c = {
  bg: "#0f1011",
  fg: "#eeece6",
  mutedFg: "#a3a39e",
  subtle: "#85867f",
  lime: "#cbf26b",
  ai: "#b8a6ff",
  danger: "#ff7a6b",
};

export const OUT = Easing.bezier(0.16, 1, 0.3, 1);
const BACK = Easing.bezier(0.34, 1.7, 0.64, 1);
export const SNAP = Easing.bezier(0.85, 0, 0.15, 1);

/** The scene's clock in beats, so every timing below sits on the music. */
export function useB() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame / fps / BEAT;
}

export const ramp = (t: number, from: number, to: number, easing: (x: number) => number = OUT) =>
  interpolate(t, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing });
export const pop = (t: number, at: number, beats = 0.6) => ramp(t, at, at + beats, BACK);
export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** A shake that dies away after a hit. */
export const shake = (t: number, at: number, size = 14) => {
  const left = 1 - ramp(t, at, at + 0.7, x => x);
  return left === 0 || t < at ? [0, 0] : [Math.sin(t * 61) * size * left, Math.cos(t * 47) * size * left];
};

/** A hard cut: shows only between two beats, punching in with a flash. */
export function Shot({ from, to, flash = 0.5, bg, style, children }: { from: number; to: number; flash?: number; bg?: string; style?: CSSProperties; children: ReactNode }) {
  const t = useB();
  if (t < from || t >= to) return null;
  return <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: bg, ...style }}>
    <div style={{ position: "absolute", inset: 0, transform: `scale(${lerp(1.07, 1, ramp(t, from, from + 0.7))})` }}>{children}</div>
    <div style={{ position: "absolute", inset: 0, background: "#fff", opacity: flash * (1 - ramp(t, from, from + 0.22, x => x)), pointerEvents: "none" }} />
  </div>;
}

/** Centres huge type in the frame. */
export function Big({ size = 240, color = c.fg, weight = 600, style, children }: { size?: number; color?: string; weight?: number; style?: CSSProperties; children: ReactNode }) {
  return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 80px", fontFamily: font.display, fontWeight: weight, fontSize: size, lineHeight: 1, letterSpacing: "-0.045em", color, ...style }}>{children}</div>;
}

/** The word that opens a scene: one beat, full screen, inverted, with a shake. */
export function Slam({ word, bg = c.lime, color = c.bg, beats = 1 }: { word: string; bg?: string; color?: string; beats?: number }) {
  const t = useB();
  const [x, y] = shake(t, 0, 16);
  return <Shot from={0} to={beats} bg={bg} flash={0.8}>
    <Big size={lerp(420, 330, ramp(t, 0, beats))} color={color} weight={700} style={{ transform: `translate(${x}px, ${y}px)` }}>{word}</Big>
  </Shot>;
}

/** Rises into place at a beat. */
export function Rise({ at, by = 40, beats = 0.7, style, children }: { at: number; by?: number; beats?: number; style?: CSSProperties; children: ReactNode }) {
  const t = useB();
  const p = ramp(t, at, at + beats);
  return <div style={{ ...style, opacity: ramp(t, at, at + beats * 0.35), transform: `translateY(${(1 - p) * by}px)` }}>{children}</div>;
}

/** Springs into place at a beat. */
export function Pop({ at, from = 0.7, style, children }: { at: number; from?: number; style?: CSSProperties; children: ReactNode }) {
  const t = useB();
  return <div style={{ ...style, opacity: ramp(t, at, at + 0.12), transform: `scale(${lerp(from, 1, pop(t, at))})` }}>{children}</div>;
}

/** Picks the recorded frame showing at a moment of a shot. */
function frameAt(shot: keyof typeof rec, seconds: number) {
  const times = rec[shot].t;
  let low = 0, high = times.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (times[middle] <= seconds) low = middle; else high = middle - 1; }
  return `rec/${shot}/${String(low).padStart(5, "0")}.jpg`;
}

/** A line of text over footage, on a scrim so it reads over any screen. */
function Say({ text, from }: { text: string; from: number }) {
  const t = useB();
  const p = pop(t, from, 0.5);
  return <>
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 320, background: "linear-gradient(transparent, rgb(8 8 9 / .92) 70%)", opacity: ramp(t, from, from + 0.1) }} />
    <div style={{ position: "absolute", left: 70, right: 70, bottom: 56, fontFamily: font.display, fontWeight: 600, fontSize: 84, lineHeight: 1.05, letterSpacing: "-0.04em", color: c.fg, opacity: ramp(t, from, from + 0.08), transform: `translateY(${(1 - p) * 30}px) scale(${lerp(1.04, 1, p)})`, transformOrigin: "0 100%" }}>{text}</div>
  </>;
}

/** One cut of real screen recording, with its camera move. */
export function Footage({ clip }: { clip: Clip }) {
  const t = useB();
  const shot = clip.shot as keyof typeof rec;
  const seconds = clip.src + (t - clip.from) * BEAT * clip.rate;
  const p = ramp(t, clip.from, clip.to, value => value);
  const start = clip.cam ?? { x: 960, y: 540, z: 1 }, end = clip.cam?.to ?? start;
  const z = lerp(start.z, end.z, p), half = [960 / z, 540 / z];
  const x = Math.min(1920 - half[0], Math.max(half[0], lerp(start.x, end.x, p))), y = Math.min(1080 - half[1], Math.max(half[1], lerp(start.y, end.y, p)));
  // Each cut arrives with a short snap of zoom.
  const snap = 1 + 0.09 * (1 - ramp(t, clip.from, clip.from + 0.6));
  return <Shot from={clip.from} to={clip.to} flash={0.28}>
    {clip.phone
      ? <div style={{ position: "absolute", left: "50%", top: 40, width: 460, height: 1000, marginLeft: -230, borderRadius: 54, border: "6px solid #2a2c30", overflow: "hidden", background: c.bg }}><Img src={staticFile(frameAt(shot, seconds))} style={{ width: "100%" }} /></div>
      : <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transformOrigin: "0 0", transform: `translate(960px, 540px) scale(${z * snap}) translate(${-x}px, ${-y}px)` }}><Img src={staticFile(frameAt(shot, seconds))} style={{ width: 1920, height: 1080 }} /></div>}
    {clip.say && <Say text={clip.say} from={clip.from} />}
    {clip.tag && <div style={{ position: "absolute", right: 56, top: 48, padding: "12px 24px", borderRadius: 14, background: c.lime, color: c.bg, fontFamily: font.mono, fontSize: 32, opacity: ramp(t, clip.from, clip.from + 0.1) }}>{clip.tag}</div>}
  </Shot>;
}

const FIX: Record<string, string> = { "D": "Da", "Agino": "Gino", "di": "Da", "Geno": "Gino", "€1800": "€1,800" };

/** The real words of the call, lighting up as they are spoken, on Whisper's timing of the recording. */
export function CallCaption({ clip }: { clip: Clip }) {
  const t = useB();
  if (t < clip.from || t >= clip.to) return null;
  const seconds = clip.src + (t - clip.from) * BEAT * clip.rate;
  const srcEnd = clip.src + (clip.to - clip.from) * BEAT * clip.rate;
  const said = words.filter(word => word.who === clip.voice && word.start >= clip.src - 0.2 && word.start < srcEnd);
  const color = clip.voice === "moneo" ? c.lime : c.fg;
  return <>
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 400, background: "linear-gradient(transparent, rgb(8 8 9 / .94) 62%)" }} />
    <div style={{ position: "absolute", left: 90, right: 90, bottom: 56 }}>
      <div style={{ fontFamily: font.mono, fontSize: 30, letterSpacing: "0.08em", textTransform: "uppercase", color: clip.voice === "moneo" ? c.lime : c.ai, marginBottom: 12 }}>{clip.voice === "moneo" ? "Moneo" : "You"}</div>
      <div style={{ display: "flex", flexWrap: "wrap", fontFamily: font.display, fontWeight: 600, fontSize: said.length > 12 ? 58 : 76, lineHeight: 1.08, letterSpacing: "-0.035em", color }}>
        {said.map((word, index) => <span key={index} style={{ marginRight: "0.26em", opacity: seconds >= word.start ? 1 : 0.22 }}>{FIX[word.word] ?? word.word}</span>)}
      </div>
    </div>
  </>;
}

const LOGO_M = "M50 142V62q0-11 8-6l38 56 38-56q8-5 8 6v80";

/** The M from the app icon; `draw` strokes it on from 0 to 1. */
export function Logo({ size, draw = 1 }: { size: number; draw?: number }) {
  return <svg width={size} height={size} viewBox="0 0 192 192" aria-hidden="true">
    <rect width="192" height="192" rx="42" fill="#121314" />
    <path d={LOGO_M} fill="none" stroke={c.lime} strokeWidth="20" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={`${draw} 1`} />
  </svg>;
}
