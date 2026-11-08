import { Big, c, font, lerp, Logo, Pop, ramp, Rise, shake, Shot, SNAP, useB } from "../kit";
import { CUES } from "../timeline";

export function Own() {
  const t = useB();
  const [x, y] = shake(t, 0, 18);
  return <>
    <Shot from={0} to={1} bg={c.lime} flash={0.9}><Big size={lerp(460, 380, ramp(t, 0, 1))} color={c.bg} weight={700} style={{ transform: `translate(${x}px, ${y}px)` }}>Own it.</Big></Shot>
    <Shot from={1} to={2} flash={0.3}><Big size={220}>Your computer.</Big></Shot>
    <Shot from={2} to={3} flash={0.3}><Big size={240} color={c.lime}>No accounts.</Big></Shot>
    <Shot from={3} to={4} flash={0.3}><Big size={240}>Open source.</Big></Shot>
    <Shot from={CUES.ownFinal} to={14} flash={1}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <Pop at={CUES.ownFinal} from={0.5}><Logo size={210} draw={ramp(t, CUES.ownFinal, CUES.ownFinal + 1.3, SNAP)} /></Pop>
        <Rise at={CUES.ownFinal + 0.7} by={30} style={{ fontFamily: font.display, fontWeight: 600, fontSize: 170, lineHeight: 1.1, letterSpacing: "-0.045em", color: c.fg, marginTop: 14 }}>Moneo</Rise>
        <Rise at={CUES.ownFinal + 1.2} by={20} style={{ fontFamily: font.sans, fontSize: 56, letterSpacing: "-0.02em", color: c.mutedFg, marginTop: 4 }}>Your money. On your machine.</Rise>
        <Pop at={CUES.ownFinal + 2} from={0.7} style={{ marginTop: 50, padding: "24px 44px", borderRadius: 18, background: c.lime, color: c.bg, fontFamily: font.mono, fontSize: 42, fontWeight: 500 }}>github.com/indkhan/Moneo</Pop>
        <Rise at={CUES.ownFinal + 2.5} by={10} style={{ position: "absolute", bottom: 46, fontFamily: font.sans, fontSize: 26, color: c.subtle }}>MIT licensed. Data leaves only for services you connect. Figures shown are sample data.</Rise>
      </div>
    </Shot>
  </>;
}
