import { Layers, Repeat, Sliders, TrendingUp } from "lucide-react";
import { Big, c, Camera, Card, Cursor, Eyebrow, font, lerp, money, Pop, ramp, Shot, Slam, smoothPath, SNAP, typed, useB, whole } from "../kit";
import { CAMS, CUES } from "../timeline";

const PROMPT = "Build a page for my Scalable portfolio, with a slider for what I add each month.";
const POSITIONS: [string, number, number][] = [["MSCI World ETF", 68400, 18.2], ["S&P 500 ETF", 31200, 21.4], ["NVIDIA", 17000, 48.6], ["Emerging Markets ETF", 14640, 9.1], ["Bitcoin", 6620.4, 31.0]];
const TOTAL = 142860.4;
const SPLIT: [string, number, string][] = [["Securities", 131240, c.lime], ["Crypto", 6620.4, c.ai], ["Cash", 5000, c.chartOut]];
const GROWTH = 0.06, YEARS = 20;
const grow = (monthly: number, years: number) => TOTAL * (1 + GROWTH) ** years + monthly * 12 * (((1 + GROWTH) ** years - 1) / GROWTH);
const HOME_CARDS: [typeof Layers, string, string, string, number][] = [
  [Repeat, "Subscription radar", "€86.40", "a month, across 7 services", 14],
  [TrendingUp, "Scalable portfolio", "€142,860", "+€14,220 this year", 14.5],
  [Sliders, "Savings what-if", "€1.08M", "in 20 years, drag to change", 15],
];

export function Build() {
  const t = useB();
  const slider = ramp(t, CUES.buildSlider, 13.2, SNAP);
  const monthly = 200 + slider * 1200;
  const curve = Array.from({ length: YEARS + 1 }, (_, year): [number, number] => [year * 96, 1080 - grow(monthly, year) / 1300000 * 900]);
  const chart = smoothPath(curve);
  return <>
    <Slam word="Build it." bg={c.ai} />
    <Shot from={1} to={4} flash={0.3}>
      <div style={{ position: "absolute", left: 110, right: 110, top: 120, fontFamily: font.display, fontWeight: 500, fontSize: 124, lineHeight: 1.08, letterSpacing: "-0.035em", color: c.fg }}>
        {typed(PROMPT, t, 1, 2.45 / PROMPT.length)}<span style={{ display: "inline-block", width: 10, height: 112, marginLeft: 10, verticalAlign: "-12px", background: c.ai }} />
      </div>
      <div style={{ position: "absolute", left: 110, bottom: 60, fontFamily: font.mono, fontSize: 36, color: c.ai, opacity: ramp(t, 3.3, 3.5) }}>Reading your portfolio · writing the page · checking the numbers</div>
    </Shot>
    <Shot from={4} to={9.25} flash={0.5}>
      <Camera keys={CAMS.build}>
        <div style={{ position: "absolute", inset: 30, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "500px 1fr", gap: 22, fontFamily: font.sans, color: c.fg }}>
          <Pop at={4} from={0.85}><Card style={{ height: "100%", padding: 40 }}>
            <Eyebrow style={{ fontSize: 24 }}>Portfolio value</Eyebrow>
            <div style={{ fontFamily: font.display, fontSize: 112, fontWeight: 500, letterSpacing: "-0.04em", marginTop: 10, fontVariantNumeric: "tabular-nums" }}>{money(TOTAL * lerp(0.8, 1, ramp(t, 4, 5, x => x)))}</div>
            <div style={{ display: "flex", height: 24, gap: 6, marginTop: 44, width: `${ramp(t, 4.8, 5.6, SNAP) * 100}%` }}>{SPLIT.map(([name, value, color]) => <div key={name} style={{ flex: value, background: color, borderRadius: 10 }} />)}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", marginTop: 34 }}>{SPLIT.map(([name, value, color]) => <div key={name}><div style={{ fontSize: 28, color: c.mutedFg, display: "flex", alignItems: "center", gap: 10 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: color }} />{name}</div><div style={{ fontFamily: font.mono, fontSize: 34, marginTop: 6 }}>{whole(value)}</div></div>)}</div>
          </Card></Pop>
          <Pop at={5.8} from={0.85}><Card style={{ height: "100%", padding: 40 }}>
            <Eyebrow style={{ fontSize: 24 }}>Gain this year</Eyebrow>
            <div style={{ fontFamily: font.mono, fontSize: 88, color: c.lime, marginTop: 10, fontVariantNumeric: "tabular-nums" }}>+{whole(14220 * ramp(t, 5.9, 6.9, x => x))}</div>
            <svg viewBox="0 0 800 220" style={{ width: "100%", marginTop: 26, overflow: "visible" }}><path d={smoothPath([[0, 200], [100, 170], [190, 180], [300, 130], [420, 140], [530, 80], [660, 70], [800, 14]])} fill="none" stroke={c.lime} strokeWidth="7" strokeLinecap="round" pathLength={1} strokeDasharray={`${ramp(t, 6, 7, x => x)} 1`} /></svg>
          </Card></Pop>
          <Pop at={6.8} from={0.9} style={{ gridColumn: "span 2" }}><Card style={{ height: "100%", padding: "20px 44px" }}>
            {POSITIONS.map(([name, value, gain], index) => <div key={name} style={{ display: "flex", alignItems: "center", height: 96, fontSize: 42, borderBottom: index < 4 ? `1px solid ${c.border}` : "none", opacity: ramp(t, 7 + index * 0.12, 7.15 + index * 0.12) }}>
              <span style={{ flex: 1, fontWeight: 500 }}>{name}</span><span style={{ fontFamily: font.mono, width: 400, textAlign: "right" }}>{money(value)}</span><span style={{ fontFamily: font.mono, width: 240, textAlign: "right", color: c.lime }}>+{gain.toFixed(1)}%</span>
            </div>)}
          </Card></Pop>
        </div>
      </Camera>
    </Shot>
    <Shot from={9.25} to={14} flash={0.6}>
      <svg viewBox="0 0 1920 1080" width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <defs><linearGradient id="swell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c.lime} stopOpacity=".45" /><stop offset="1" stopColor={c.lime} stopOpacity=".03" /></linearGradient></defs>
        <path d={`${chart}L1920,1080L0,1080Z`} fill="url(#swell)" />
        <path d={chart} fill="none" stroke={c.lime} strokeWidth="8" />
      </svg>
      <div style={{ position: "absolute", left: 110, top: 70, fontFamily: font.sans, color: c.fg, textShadow: "0 4px 30px #0f1011" }}>
        <div style={{ fontSize: 56, color: c.mutedFg }}>In {YEARS} years at 6% a year</div>
        <div style={{ fontFamily: font.display, fontSize: 280, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.05em", fontVariantNumeric: "tabular-nums", color: c.lime }}>{whole(grow(monthly, YEARS))}</div>
      </div>
      <div style={{ position: "absolute", left: 110, width: 900, top: 800, fontFamily: font.sans, color: c.fg }}>
        <div style={{ fontSize: 52, textShadow: "0 4px 30px #0f1011" }}>Add <span style={{ fontFamily: font.mono, color: c.lime }}>{whole(monthly)}</span> a month</div>
        <div style={{ position: "relative", height: 18, marginTop: 34, borderRadius: 99, background: c.input }}>
          <div style={{ width: `${slider * 100}%`, height: "100%", borderRadius: 99, background: c.lime }} />
          <div style={{ position: "absolute", left: `${slider * 100}%`, top: -26, marginLeft: -35, width: 70, height: 70, borderRadius: "50%", background: c.fg, boxShadow: "0 6px 20px rgb(0 0 0 / .6)" }} />
        </div>
      </div>
      <Cursor size={72} path={[{ t: 9.3, x: 400, y: 1000 }, { t: CUES.buildSlider + 0.1, x: 112, y: 908 }, { t: 13.2, x: 1012, y: 908 }]} clicks={[CUES.buildSlider + 0.1]} />
    </Shot>
    <Shot from={CUES.buildHome} to={16} flash={0.4}>
      <Big size={92} style={{ alignItems: "flex-start", paddingTop: 110 }}>Then it lives on your Home.</Big>
      <div style={{ position: "absolute", left: 90, right: 90, top: 320, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 26 }}>
        {HOME_CARDS.map(([Icon, title, figure, line, at]) => <Pop key={title} at={at} from={0.6}><Card style={{ height: 560, padding: 44, background: c.aiSoft, borderColor: c.aiBorder, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <Icon size={72} color={c.ai} strokeWidth={1.5} />
          <div><div style={{ fontSize: 46, fontWeight: 500, letterSpacing: "-0.02em" }}>{title}</div>
          <div style={{ fontFamily: font.display, fontSize: 108, fontWeight: 600, letterSpacing: "-0.04em", color: c.lime, marginTop: 14 }}>{figure}</div>
          <div style={{ fontSize: 32, color: c.mutedFg, marginTop: 8 }}>{line}</div></div>
        </Card></Pop>)}
      </div>
    </Shot>
  </>;
}
