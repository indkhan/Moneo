import { CheckCircle2, Loader2 } from "lucide-react";
import { Big, c, Card, Cursor, Eyebrow, font, lerp, Orb, Pop, ramp, shake, Shot, Slam, useB, voice, Words } from "../kit";
import { CUES } from "../timeline";

function Task({ at, doneAt, title, working, done }: { at: number; doneAt: number; title: string; working: string; done: string }) {
  const t = useB();
  const finished = t >= doneAt;
  return <Pop at={at} from={0.8}><div style={{ display: "flex", alignItems: "center", gap: 34, padding: "34px 44px", borderRadius: 28, border: `1px solid ${finished ? c.lime : c.input}`, background: c.card }}>
    {finished ? <CheckCircle2 size={72} color={c.lime} style={{ flexShrink: 0, transform: `scale(${lerp(1.6, 1, ramp(t, doneAt, doneAt + 0.4))})` }} /> : <Loader2 size={72} color={c.ai} style={{ flexShrink: 0, transform: `rotate(${t * 360}deg)` }} />}
    <div><div style={{ fontSize: 60, fontWeight: 500, letterSpacing: "-0.02em" }}>{title}</div><div style={{ fontSize: 42, color: c.mutedFg, marginTop: 4 }}>{finished ? done : working}</div></div>
  </div></Pop>;
}

/** The orb behind the spoken words, filling the frame. */
function BigOrb({ a, b, talking = true }: { a: string; b: string; talking?: boolean }) {
  const t = useB();
  return <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", opacity: 0.9 }}><Orb size={1050} level={talking ? voice(t) : 0.1} spin={t * 40} a={a} b={b} /></div>;
}

const spoken = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 120px", fontFamily: font.display, fontWeight: 600, fontSize: 168, lineHeight: 1.04, letterSpacing: "-0.04em", color: c.fg, textShadow: "0 6px 50px rgb(0 0 0 / .75)" } as const;

export function Call() {
  const t = useB();
  const saved = t >= CUES.callSave;
  const [x, y] = shake(t, CUES.callYes, 20);
  return <>
    <Slam word="Call it." />
    <Shot from={1} to={3.5}><BigOrb a={c.ai} b={c.aiBorder} /><div style={spoken}><Words text="Can I afford Lisbon in June?" at={1} per={0.38} highlight={["Lisbon"]} /></div></Shot>
    <Shot from={3.5} to={5.5} flash={0.3}><BigOrb a={c.ai} b={c.lime} /><div style={spoken}><Words text="Oh, and I spent €42 at Trattoria." at={3.5} per={0.3} highlight={["€42"]} /></div></Shot>
    <Shot from={5.5} to={8} flash={0.3}>
      <div style={{ position: "absolute", left: 80, right: 80, top: 130, fontFamily: font.sans, color: c.fg }}>
        <Eyebrow style={{ fontSize: 40, marginBottom: 34 }}>{t < 7.25 ? "Working on 2 of 2" : "All done"}</Eyebrow>
        <div style={{ display: "grid", gap: 30 }}>
          <Task at={5.55} doneAt={7.25} title="Can I afford Lisbon in June?" working="Reading your forecast…" done="Answered from your records" />
          <Task at={6} doneAt={6.75} title="€42 at Trattoria Da Gino" working="Making a card…" done="Waiting for your tap" />
        </div>
      </div>
    </Shot>
    <Shot from={CUES.callYes} to={CUES.callAmount} bg={c.lime} flash={0.8}><Big size={560} color={c.bg} weight={700} style={{ transform: `translate(${x}px, ${y}px)` }}>Yes.</Big></Shot>
    <Shot from={CUES.callAmount} to={10.25} flash={0.3}>
      <BigOrb a={c.lime} b="#7fa63a" />
      <div style={{ ...spoken, flexDirection: "column" }}>
        <div style={{ fontSize: 300, color: c.fg, fontVariantNumeric: "tabular-nums" }}>€{Math.round(lerp(1200, 3180, ramp(t, 9, 9.7))).toLocaleString("en-GB")}</div>
        <div style={{ fontSize: 92, marginTop: 16, opacity: ramp(t, 9.3, 9.5) }}>left after June. Lisbon included.</div>
      </div>
    </Shot>
    <Shot from={10.25} to={14} flash={0.4}>
      <div style={{ position: "absolute", left: 130, right: 130, top: 190, fontFamily: font.sans, color: c.fg, transform: `scale(${lerp(1, 1.05, ramp(t, 10.25, 14, x => x))})` }}>
        <Eyebrow style={{ fontSize: 36, marginBottom: 30 }}>Tap to save · nothing is saved until you do</Eyebrow>
        <Card style={{ background: c.aiSoft, borderColor: c.aiBorder, padding: 60, borderRadius: 34, height: 500 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 84, fontWeight: 500, letterSpacing: "-0.02em" }}>Trattoria Da Gino</div>
            <div style={{ fontFamily: font.mono, fontSize: 84 }}>−€42.00</div>
          </div>
          <div style={{ fontSize: 50, color: c.mutedFg, marginTop: 14 }}>Eating out · Revolut · today</div>
          {saved
            ? <Pop at={CUES.callSave} from={0.8} style={{ display: "flex", alignItems: "center", gap: 26, marginTop: 66, height: 130, fontSize: 80, fontWeight: 500, color: c.lime }}><CheckCircle2 size={84} />Added</Pop>
            : <div style={{ display: "flex", gap: 26, marginTop: 66 }}>
              <div style={{ height: 130, width: 330, background: c.lime, color: c.bg, borderRadius: 24, fontSize: 64, fontWeight: 600, display: "grid", placeItems: "center" }}>Add</div>
              <div style={{ height: 130, width: 330, border: `2px solid ${c.input}`, borderRadius: 24, fontSize: 64, display: "grid", placeItems: "center" }}>Dismiss</div>
            </div>}
        </Card>
      </div>
      <Cursor size={72} path={[{ t: 10.6, x: 1300, y: 980 }, { t: CUES.callSave, x: 370, y: 690 }, { t: 13, x: 520, y: 870 }]} clicks={[CUES.callSave]} />
    </Shot>
  </>;
}
