import type { ComponentType, ReactNode } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { c } from "./kit";
import { BEAT, SCENES } from "./timeline";
import { Hook } from "./scenes/Hook";
import { Call } from "./scenes/Call";
import { See } from "./scenes/See";
import { Budget } from "./scenes/Budget";
import { Plan } from "./scenes/Plan";
import { Build } from "./scenes/Build";
import { Trade } from "./scenes/Trade";
import { Power } from "./scenes/Power";
import { Everything } from "./scenes/Everything";
import { Own } from "./scenes/Own";

const parts: [keyof typeof SCENES, ComponentType][] = [["hook", Hook], ["call", Call], ["see", See], ["budget", Budget], ["plan", Plan], ["build", Build], ["trade", Trade], ["power", Power], ["everything", Everything], ["own", Own]];

/** Graphite ground with two moving glows, lime for money and violet for the AI, as in the app. */
function Backdrop() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return <AbsoluteFill style={{ background: c.bg }}>
    <div style={{ position: "absolute", width: 1300, height: 1300, left: 1000 + Math.sin(t / 2) * 300, top: -560 + Math.cos(t / 1.6) * 160, background: "radial-gradient(circle, rgb(184 166 255 / .16), transparent 65%)" }} />
    <div style={{ position: "absolute", width: 1300, height: 1300, left: -480 + Math.cos(t / 2.4) * 280, top: 240 + Math.sin(t / 2) * 160, background: "radial-gradient(circle, rgb(203 242 107 / .09), transparent 65%)" }} />
    <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(rgb(255 255 255 / .05) 1.2px, transparent 1.2px)", backgroundSize: "44px 44px" }} />
  </AbsoluteFill>;
}

/** The whole picture kicks with the drum while the beat is running. */
function BeatPunch({ children }: { children: ReactNode }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beats = frame / fps / BEAT;
  const on = beats >= SCENES.call.start && beats < SCENES.own.start + 4;
  const scale = on ? 1 + 0.012 * Math.exp(-(beats % 1) * 6) : 1;
  return <AbsoluteFill style={{ transform: `scale(${scale})` }}>{children}</AbsoluteFill>;
}

export function Promo() {
  const { fps } = useVideoConfig();
  return <AbsoluteFill>
    <Backdrop />
    <BeatPunch>
      {parts.map(([name, Part]) => <Sequence key={name} name={name} from={Math.round(SCENES[name].start * BEAT * fps)} durationInFrames={Math.round(SCENES[name].beats * BEAT * fps)}><Part /></Sequence>)}
    </BeatPunch>
    <Audio src={staticFile("moneo-promo-track.wav")} />
  </AbsoluteFill>;
}
