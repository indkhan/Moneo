import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Big, c, CallCaption, Footage, font, lerp, Logo, Pop, ramp, Rise, shake, Shot, Slam, SNAP, useB } from "./kit";
import rec from "./rec.json";
import { BEAT, ORDER, OWN_FINAL, SCENES_DATA, STARTS, type Clip, type SceneName, VOICE_WINDOWS, allClips } from "./timeline";

const BG = { lime: c.lime, ai: c.ai, fg: c.fg } as const;

function Crossed({ from, word }: { from: number; word: string }) {
  const t = useB();
  return <Shot from={from} to={from + 1} flash={0.25}>
    <Big size={230}><span style={{ position: "relative", display: "inline-block" }}>{word}<span style={{ position: "absolute", left: -20, right: -20, top: "54%", height: 22, borderRadius: 12, background: c.danger, transformOrigin: "0 50%", transform: `scaleX(${ramp(t, from + 0.42, from + 0.72)})` }} /></span></Big>
  </Shot>;
}

function Hook() {
  const t = useB();
  const [x, y] = shake(t, 4, 22);
  return <>
    <Crossed from={0} word="Spreadsheets." />
    <Crossed from={1} word="Six bank apps." />
    <Crossed from={2} word="Lost receipts." />
    <Shot from={3} to={4} flash={0.3}><Big size={210}>What if you could just</Big></Shot>
    <Shot from={4} to={5} bg={c.lime} flash={0.9}><Big size={lerp(620, 500, ramp(t, 4, 5))} color={c.bg} weight={700} style={{ transform: `translate(${x}px, ${y}px)` }}>call</Big></Shot>
    <Shot from={5} to={6} flash={0.3}><Big size={270} color={c.lime}>your money?</Big></Shot>
  </>;
}

function Own() {
  const t = useB();
  const [x, y] = shake(t, 0, 18);
  return <>
    <Shot from={0} to={1} bg={c.lime} flash={0.9}><Big size={lerp(460, 380, ramp(t, 0, 1))} color={c.bg} weight={700} style={{ transform: `translate(${x}px, ${y}px)` }}>Own it.</Big></Shot>
    <Shot from={1} to={2} flash={0.3}><Big size={220}>Your computer.</Big></Shot>
    <Shot from={2} to={3} flash={0.3}><Big size={240} color={c.lime}>No accounts.</Big></Shot>
    <Shot from={3} to={4} flash={0.3}><Big size={240}>Open source.</Big></Shot>
    <Shot from={OWN_FINAL} to={14} flash={1}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Pop at={OWN_FINAL} from={0.5}><Logo size={210} draw={ramp(t, OWN_FINAL, OWN_FINAL + 1.3, SNAP)} /></Pop>
        <Rise at={OWN_FINAL + 0.7} by={30} style={{ fontFamily: font.display, fontWeight: 600, fontSize: 170, lineHeight: 1.1, letterSpacing: "-0.045em", color: c.fg, marginTop: 14 }}>Moneo</Rise>
        <Rise at={OWN_FINAL + 1.2} by={20} style={{ fontFamily: font.sans, fontSize: 56, letterSpacing: "-0.02em", color: c.mutedFg, marginTop: 4 }}>Your money. On your machine.</Rise>
        <Pop at={OWN_FINAL + 2} from={0.7} style={{ marginTop: 50, padding: "24px 44px", borderRadius: 18, background: c.lime, color: c.bg, fontFamily: font.mono, fontSize: 42, fontWeight: 500 }}>github.com/indkhan/Moneo</Pop>
        <Rise at={OWN_FINAL + 2.5} by={10} style={{ position: "absolute", bottom: 40, textAlign: "center", fontFamily: font.sans, fontSize: 25, lineHeight: 1.35, color: c.subtle }}>Recorded in the real app with made-up data and a stand-in Scalable account. Some steps are sped up.<br />Voice calls need an OpenAI API key. Data leaves only for services you connect. MIT licensed.</Rise>
      </div>
    </Shot>
  </>;
}

function SceneView({ name }: { name: SceneName }) {
  const scene = SCENES_DATA[name];
  return <>
    {name === "hook" && <Hook />}
    {name === "own" && <Own />}
    {scene.word && name !== "own" && <Slam word={scene.word} bg={BG[scene.bg!]} />}
    {scene.clips.map((clip: Clip, index) => <Footage key={index} clip={clip} />)}
    {scene.clips.filter(clip => clip.voice).map((clip, index) => <CallCaption key={index} clip={clip} />)}
  </>;
}

/** The whole picture kicks with the drum while the beat is running. */
function BeatPunch({ children }: { children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beats = frame / fps / BEAT;
  const on = beats >= STARTS.see && beats < STARTS.own + OWN_FINAL;
  return <AbsoluteFill style={{ transform: `scale(${on ? 1 + 0.008 * Math.exp(-(beats % 1) * 6) : 1})` }}>{children}</AbsoluteFill>;
}

function Backdrop() {
  return <AbsoluteFill style={{ background: c.bg }}>
    <div style={{ position: "absolute", width: 1300, height: 1300, left: 1000, top: -560, background: "radial-gradient(circle, rgb(184 166 255 / .16), transparent 65%)" }} />
    <div style={{ position: "absolute", width: 1300, height: 1300, left: -480, top: 240, background: "radial-gradient(circle, rgb(203 242 107 / .09), transparent 65%)" }} />
  </AbsoluteFill>;
}

/** Quiet under anyone speaking, full everywhere else. */
function musicVolume(frame: number, fps: number) {
  const beats = frame / fps / BEAT;
  const inVoice = VOICE_WINDOWS.some(([from, to]) => beats >= from - 0.1 && beats < to + 0.1);
  return inVoice ? 0.22 : 1;
}

export function Promo() {
  const { fps } = useVideoConfig();
  const voices = rec.call.audio as { who: string; file: string; offset: number }[];
  return <AbsoluteFill>
    <Backdrop />
    <BeatPunch>
      {ORDER.map(name => <Sequence key={name} name={name} from={Math.round(STARTS[name] * BEAT * fps)} durationInFrames={Math.round(SCENES_DATA[name].beats * BEAT * fps)}><SceneView name={name} /></Sequence>)}
    </BeatPunch>
    <Audio src={staticFile("moneo-promo-track.wav")} volume={frame => musicVolume(frame, fps)} />
    {allClips.filter(clip => clip.voice).map((clip, index) => {
      const voice = voices.find(item => item.who === clip.voice)!;
      return <Sequence key={index} from={Math.round(clip.start * BEAT * fps)} durationInFrames={Math.round((clip.end - clip.start) * BEAT * fps)}>
        <Audio src={staticFile(`rec/call/${voice.file}`)} trimBefore={Math.max(0, Math.round((clip.src - voice.offset) * fps))} playbackRate={clip.rate} volume={1.2} />
      </Sequence>;
    })}
  </AbsoluteFill>;
}
