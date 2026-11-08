import type { CSSProperties, ReactNode } from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadDisplay } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadSans } from "@remotion/google-fonts/Geist";
import { loadFont as loadMono } from "@remotion/google-fonts/GeistMono";
import { BEAT, type CamKey } from "./timeline";

const display = loadDisplay("normal", { weights: ["500", "600", "700"], subsets: ["latin"] }).fontFamily;
const sans = loadSans("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;
const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

export const font = { display, sans, mono };

// Moneo's dark theme, copied from app/globals.css.
export const c = {
  bg: "#0f1011",
  card: "#16171a",
  fg: "#eeece6",
  muted: "#1d1e22",
  mutedFg: "#a3a39e",
  subtle: "#85867f",
  border: "#24262a",
  input: "#2a2c30",
  lime: "#cbf26b",
  ai: "#b8a6ff",
  aiSoft: "#1a1922",
  aiBorder: "#3d3760",
  successSoft: "#1c2410",
  warning: "#ff9a76",
  danger: "#ff7a6b",
  chartOut: "#5b5d62",
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

const euros = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" });
const wholeEuros = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
export const money = (value: number) => euros.format(value);
export const whole = (value: number) => wholeEuros.format(value);

/** A voice-like level from 0 to 1. */
export const voice = (t: number) => Math.max(0, 0.5 + 0.28 * Math.sin(t * 8) + 0.22 * Math.sin(t * 13 + 1) + 0.16 * Math.sin(t * 3.3 + 2));

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

/** A virtual camera over a 1920x1080 canvas: snaps between framings and blurs while it moves. */
export function Camera({ keys, children, style }: { keys: CamKey[]; children: ReactNode; style?: CSSProperties }) {
  const t = useB();
  const at = (time: number) => {
    let { x, y, z } = keys[0];
    for (const key of keys.slice(1)) {
      const p = ramp(time, key.b, key.b + (key.d ?? 0.5), SNAP);
      x = lerp(x, key.x, p); y = lerp(y, key.y, p); z = lerp(z, key.z, p);
    }
    return { x, y, z };
  };
  const now = at(t), before = at(t - 0.04);
  const speed = Math.hypot(now.x - before.x, now.y - before.y) * now.z + Math.abs(now.z - before.z) * 500;
  const blur = Math.min(16, speed * 0.16);
  return <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transformOrigin: "0 0", transform: `translate(960px, 540px) scale(${now.z}) translate(${-now.x}px, ${-now.y}px)`, filter: blur > 0.5 ? `blur(${blur}px)` : undefined, ...style }}>{children}</div>;
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

export function Card({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return <div style={{ background: c.card, border: `1px solid ${c.border}`, borderRadius: 20, padding: 32, fontFamily: font.sans, color: c.fg, ...style }}>{children}</div>;
}

export function Eyebrow({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return <div style={{ fontFamily: font.mono, fontSize: 19, letterSpacing: "0.08em", textTransform: "uppercase", color: c.subtle, ...style }}>{children}</div>;
}

/** A pointer that darts between waypoints and sends a shockwave where it clicks. */
export function Cursor({ path, clicks = [], size = 44 }: { path: { t: number; x: number; y: number }[]; clicks?: number[]; size?: number }) {
  const t = useB();
  const times = path.map(point => point.t);
  const at = (values: number[]) => interpolate(t, times, values, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: SNAP });
  const x = at(path.map(point => point.x)), y = at(path.map(point => point.y));
  const pressed = clicks.some(click => t >= click && t < click + 0.25);
  return <div style={{ position: "absolute", inset: 0, zIndex: 20, pointerEvents: "none", opacity: ramp(t, times[0] - 0.2, times[0]) }}>
    {clicks.map(click => {
      const p = ramp(t, click, click + 1);
      return t >= click && p < 1 ? <div key={click} style={{ position: "absolute", left: x - 90, top: y - 90, width: 180, height: 180, borderRadius: "50%", border: `5px solid ${c.lime}`, opacity: 1 - p, transform: `scale(${0.1 + p * 1.6})` }} /> : null;
    })}
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: "absolute", left: x - size * 0.18, top: y - size * 0.14, transform: `scale(${pressed ? 0.78 : 1})`, filter: "drop-shadow(0 6px 10px rgb(0 0 0 / .55))" }}>
      <path d="M5 3l14 8.2-6.1 1.4L9.6 19z" fill="#fff" stroke="#0f1011" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  </div>;
}

/** Text that hits word by word from a beat. */
export function Words({ text, at, per = 0.5, highlight, style }: { text: string; at: number; per?: number; highlight?: string[]; style?: CSSProperties }) {
  const t = useB();
  return <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", ...style }}>{text.split(" ").map((word, index) => {
    const start = at + index * per, p = pop(t, start, 0.45);
    return <span key={index} style={{ opacity: ramp(t, start, start + 0.08), display: "inline-block", transform: `scale(${lerp(1.5, 1, p)})`, marginRight: "0.26em", color: highlight?.includes(word) ? c.lime : undefined }}>{word}</span>;
  })}</div>;
}

export function typed(text: string, t: number, at: number, per: number) {
  return text.slice(0, Math.max(0, Math.floor((t - at) / per)));
}

/** A smooth line through points, the same curve for every chart. */
export function smoothPath(points: [number, number][]) {
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[Math.max(0, i - 1)], points[i], points[i + 1], points[Math.min(points.length - 1, i + 2)]];
    path += `C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return path;
}

/** Moneo's call orb, driven by a level and two tones like components/voice-call.tsx. */
export function Orb({ size, level, spin, a, b }: { size: number; level: number; spin: number; a: string; b: string }) {
  const core = size * 0.62;
  return <div style={{ position: "relative", width: size, height: size, display: "grid", placeItems: "center" }}>
    <div style={{ position: "absolute", inset: "2%", borderRadius: "50%", background: `radial-gradient(circle, ${a}, transparent 68%)`, opacity: 0.5, transform: `scale(${1 + level * 0.5})` }} />
    <div style={{ position: "absolute", inset: "10%", borderRadius: "50%", border: `2px solid ${a}66`, transform: `scale(${1 + level * 0.3})` }} />
    <div style={{ position: "relative", width: core, height: core, borderRadius: "50%", overflow: "hidden", transform: `scale(${1 + level * 0.14})`, boxShadow: `inset 0 -10px 30px rgb(0 0 0 / .18), 0 14px 60px -14px ${a}` }}>
      <div style={{ position: "absolute", inset: "-25%", filter: "blur(10px)", background: `conic-gradient(from ${90 + spin}deg, ${a}, ${b}, ${a})` }} />
      <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "radial-gradient(circle at 32% 28%, rgb(255 255 255 / .5), transparent 48%)" }} />
    </div>
  </div>;
}

const LOGO_M = "M50 142V62q0-11 8-6l38 56 38-56q8-5 8 6v80";

/** The M from the app icon; `draw` strokes it on from 0 to 1. */
export function Logo({ size, draw = 1 }: { size: number; draw?: number }) {
  return <svg width={size} height={size} viewBox="0 0 192 192" aria-hidden="true">
    <rect width="192" height="192" rx="42" fill="#121314" />
    <path d={LOGO_M} fill="none" stroke={c.lime} strokeWidth="20" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={`${draw} 1`} />
  </svg>;
}
