import { CheckCircle2 } from "lucide-react";
import { Big, c, Camera, Card, Cursor, font, Pop, ramp, shake, Shot, Slam, useB } from "../kit";
import { CAMS, CUES } from "../timeline";

const FIGURES: [string, string][] = [["Shares", "8.9"], ["Price", "€112.40"], ["Estimated total", "€1,000.36"], ["Order cost", "€0.99"]];

export function Trade() {
  const t = useB();
  const left = 272 - Math.floor(t * 0.43);
  const sent = t >= CUES.tradeBuy;
  const [x, y] = shake(t, CUES.tradeBuy, 14);
  return <>
    <Slam word="Trade it." />
    <Shot from={1} to={6.5} flash={0.3}>
      <Camera keys={CAMS.trade} style={{ fontFamily: font.sans, color: c.fg }}>
        <Pop at={1} from={0.8} style={{ position: "absolute", right: 150, top: 70 }}><div style={{ padding: "22px 40px", borderRadius: 26, background: c.muted, fontSize: 56 }}>Buy €1,000 of MSCI World</div></Pop>
        <Pop at={1.5} from={0.85} style={{ position: "absolute", left: 150, right: 150, top: 210, transform: `translate(${x}px, ${y}px)` }}>
          <Card style={{ background: c.aiSoft, borderColor: c.aiBorder, padding: 56, height: 760, borderRadius: 32 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ padding: "10px 28px", borderRadius: 99, background: c.successSoft, color: c.lime, fontSize: 38, fontWeight: 600 }}>Buy · market</span>
              {!sent && <span style={{ fontFamily: font.mono, fontSize: 38, color: c.mutedFg }}>Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>}
            </div>
            <div style={{ fontSize: 72, fontWeight: 500, marginTop: 30, letterSpacing: "-0.02em" }}>iShares Core MSCI World</div>
            <div style={{ fontFamily: font.mono, fontSize: 34, color: c.mutedFg, marginTop: 4 }}>IE00B4L5Y983 · Scalable</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, marginTop: 50 }}>{FIGURES.map(([label, value], index) => <div key={label} style={{ opacity: ramp(t, 2.5 + index * 0.25, 2.65 + index * 0.25) }}><div style={{ fontSize: 34, color: c.mutedFg }}>{label}</div><div style={{ fontFamily: font.mono, fontSize: 50, marginTop: 8 }}>{value}</div></div>)}</div>
            <div style={{ height: 120, marginTop: 56 }}>
              {sent
                ? <Pop at={CUES.tradeBuy} from={0.8} style={{ display: "flex", alignItems: "center", gap: 22, height: "100%", fontSize: 58, fontWeight: 500, color: c.lime }}><CheckCircle2 size={64} />Order sent to Scalable</Pop>
                : <div style={{ display: "flex", gap: 22 }}>
                  <div style={{ height: 116, width: 300, borderRadius: 20, background: c.lime, color: c.bg, fontSize: 56, fontWeight: 600, display: "grid", placeItems: "center" }}>Buy</div>
                  <div style={{ height: 116, width: 300, borderRadius: 20, border: `2px solid ${c.input}`, fontSize: 56, display: "grid", placeItems: "center" }}>Dismiss</div>
                </div>}
            </div>
          </Card>
        </Pop>
        <Cursor size={64} path={[{ t: 3.9, x: 1100, y: 1000 }, { t: CUES.tradeBuy, x: 350, y: 800 }, { t: 6.4, x: 400, y: 880 }]} clicks={[CUES.tradeBuy]} />
      </Camera>
    </Shot>
    <Shot from={6.5} to={8} bg={c.lime} flash={0.7}><Big size={190} color={c.bg} weight={700}><div>Only your tap<br />sends it.</div></Big></Shot>
  </>;
}
