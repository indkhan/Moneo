import { Phone } from "lucide-react";
import { Big, c, Cursor, font, lerp, Logo, pop, ramp, shake, Shot, useB } from "../kit";
import { CUES } from "../timeline";

/** A chore that gets crossed out on the off-beat. */
function Crossed({ from, word }: { from: number; word: string }) {
  const t = useB();
  return <Shot from={from} to={from + 1} flash={0.25}>
    <Big size={230}><span style={{ position: "relative", display: "inline-block" }}>{word}<span style={{ position: "absolute", left: -20, right: -20, top: "54%", height: 22, borderRadius: 12, background: c.danger, transformOrigin: "0 50%", transform: `scaleX(${ramp(t, from + 0.42, from + 0.72)})` }} /></span></Big>
  </Shot>;
}

export function Hook() {
  const t = useB();
  const ringing = t < CUES.hookAnswer ? Math.sin(t * 40) * 2.2 * Math.max(Math.exp(-Math.max(0, t - 7) * 2.5), t >= 8 ? Math.exp(-(t - 8) * 2.5) : 0) : 0;
  const [x, y] = shake(t, 5, 22);
  const answered = ramp(t, CUES.hookAnswer, 10, x => x * x);
  return <>
    <Crossed from={0} word="Spreadsheets." />
    <Crossed from={1} word="Six bank apps." />
    <Crossed from={2} word="Lost receipts." />
    <Shot from={3} to={4} flash={0.3}><Big size={280}>What if</Big></Shot>
    <Shot from={4} to={5} flash={0.3}><Big size={250}>you could just</Big></Shot>
    <Shot from={5} to={6} bg={c.lime} flash={0.9}><Big size={lerp(620, 500, ramp(t, 5, 6))} color={c.bg} weight={700} style={{ transform: `translate(${x}px, ${y}px)` }}>call</Big></Shot>
    <Shot from={6} to={7} flash={0.3}><Big size={280} color={c.lime}>your money?</Big></Shot>
    <Shot from={7} to={10} flash={0.5}>
      <div style={{ position: "absolute", left: "50%", top: "50%", display: "flex", alignItems: "center", gap: 44, width: 1180, padding: "38px 40px", background: c.card, border: `1px solid ${c.input}`, borderRadius: 48, boxShadow: "0 60px 140px -30px rgb(0 0 0 / .9)", transform: `translate(-50%, -50%) scale(${lerp(0.6, 1, pop(t, 7)) + answered * 0.5}) rotate(${ringing}deg)`, opacity: 1 - answered * 0.9 }}>
        <Logo size={170} />
        <div style={{ flex: 1, fontFamily: font.sans }}>
          <div style={{ fontSize: 78, fontWeight: 600, color: c.fg, letterSpacing: "-0.02em" }}>Moneo</div>
          <div style={{ fontSize: 50, color: c.mutedFg }}>Incoming call</div>
        </div>
        <div style={{ width: 176, height: 176, borderRadius: "50%", background: c.lime, display: "grid", placeItems: "center", transform: `scale(${t > CUES.hookAnswer ? 0.86 : 1 + Math.max(0, Math.sin((t % 1) * Math.PI)) * 0.08})` }}>
          <Phone size={84} color={c.bg} fill={c.bg} />
        </div>
      </div>
      <Cursor size={80} path={[{ t: 8.6, x: 1500, y: 960 }, { t: CUES.hookAnswer, x: 1405, y: 548 }]} clicks={[CUES.hookAnswer]} />
    </Shot>
  </>;
}
