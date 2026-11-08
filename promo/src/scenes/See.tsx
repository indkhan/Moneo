import { ArrowLeftRight, CreditCard, LayoutGrid, Repeat, Sparkles, Target, TrendingUp, type LucideIcon } from "lucide-react";
import { c, Camera, Card, Eyebrow, font, lerp, money, Pop, ramp, Shot, Slam, smoothPath, useB } from "../kit";
import { CAMS } from "../timeline";

const RAIL: [string, LucideIcon][] = [["Overview", LayoutGrid], ["Transactions", ArrowLeftRight], ["Accounts", CreditCard], ["Recurring", Repeat], ["Plan", Target], ["Wealth", TrendingUp], ["AI", Sparkles]];
const WORTH = [131, 134, 133, 138, 142, 141, 147, 152, 151, 158, 163, 161, 166, 170, 174, 177.9];
const ACCOUNTS: [string, string, number][] = [["Scalable Capital", "Investments", 142860.4], ["Commerzbank", "Savings", 28400], ["Revolut", "Checking", 6420.15]];
const WAITING = ["3 new subscriptions spotted", "Rent is due on the 1st", "14 synced transactions to review"];
const SYNCS: [string, string, number][] = [["Revolut", "Synced · 14 new", 6.75], ["Commerzbank", "Synced · 6 new", 7.25], ["october-statement.csv", "Imported · 212 rows · Undo", 7.75], ["Scalable Capital", "Portfolio up to date", 8.25]];
const TOTAL = 177920.55;

export function See() {
  const t = useB();
  const scene = t - 1;
  const reveal = ramp(scene, 0, 2.2, x => x);
  const points = WORTH.map((value, index): [number, number] => [index * (880 / (WORTH.length - 1)), 200 - (value - 125) * 3.4]);
  const line = smoothPath(points);
  return <>
    <Slam word="See it." bg={c.ai} />
    <Shot from={1} to={10}>
      <Camera keys={CAMS.see.map(key => ({ ...key, b: key.b + 1 }))}>
        <div style={{ position: "absolute", left: 30, top: 30, right: 30, bottom: 30, background: c.bg, border: `1px solid ${c.input}`, borderRadius: 26, display: "flex", overflow: "hidden", fontFamily: font.sans, color: c.fg }}>
          <div style={{ width: 128, borderRight: `1px solid ${c.border}`, padding: "26px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            {RAIL.map(([label, Icon], index) => <div key={label} style={{ width: 108, padding: "13px 0", borderRadius: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 7, fontSize: 16, color: index === 0 ? c.fg : c.mutedFg, background: index === 0 ? c.muted : "transparent" }}><Icon size={28} strokeWidth={1.6} />{label}</div>)}
          </div>
          <div style={{ flex: 1, padding: 24, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, alignContent: "start" }}>
            <Card style={{ gridColumn: "span 2", padding: 36, height: 540 }}>
              <Eyebrow>Net worth</Eyebrow>
              <div style={{ fontFamily: font.display, fontSize: 112, fontWeight: 500, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums", marginTop: 8, lineHeight: 1.05 }}>{money(TOTAL * lerp(0.74, 1, reveal))}</div>
              <div style={{ fontFamily: font.mono, fontSize: 26, color: c.lime, marginTop: 4 }}>+€46,900 in 15 months</div>
              <svg viewBox="0 0 880 200" style={{ width: "100%", height: 230, marginTop: 14, overflow: "visible" }}>
                <defs><linearGradient id="worth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c.lime} stopOpacity=".32" /><stop offset="1" stopColor={c.lime} stopOpacity="0" /></linearGradient><clipPath id="worthClip"><rect width={880 * reveal} height="240" y="-20" /></clipPath></defs>
                <g clipPath="url(#worthClip)"><path d={`${line}L880,200L0,200Z`} fill="url(#worth)" /><path d={line} fill="none" stroke={c.lime} strokeWidth="5" strokeLinecap="round" /></g>
              </svg>
            </Card>
            <Card style={{ height: 540, background: c.aiSoft, borderColor: c.aiBorder, padding: 30 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: c.ai, fontSize: 30, fontWeight: 500 }}><Sparkles size={28} />Waiting for you</div>
              <div style={{ marginTop: 20, display: "grid", gap: 16 }}>{WAITING.map((item, index) => <Pop key={item} at={5 + index * 0.25} from={0.8}><div style={{ border: `1px solid ${c.aiBorder}`, borderRadius: 14, padding: "26px 20px", fontSize: 28, lineHeight: 1.2 }}>{item}</div></Pop>)}</div>
            </Card>
            {ACCOUNTS.map(([name, kind, value], index) => <Pop key={name} at={3.75 + index * 0.2} from={0.85}><Card style={{ padding: 28, height: 340 }}>
              <div style={{ fontSize: 34, fontWeight: 500 }}>{name}</div><div style={{ fontSize: 26, color: c.mutedFg, marginTop: 4 }}>{kind}</div>
              <div style={{ fontFamily: font.mono, fontSize: 46, marginTop: 56 }}>{money(value)}</div>
            </Card></Pop>)}
          </div>
        </div>
      </Camera>
      {SYNCS.map(([name, status, at], index) => <Pop key={name} at={at} from={0.7} style={{ position: "absolute", right: 70, top: 100 + index * 170, zIndex: 8 }}><div style={{ width: 760, padding: "26px 34px", borderRadius: 24, background: "#24262b", border: `1px solid ${c.lime}`, boxShadow: "0 30px 60px -18px rgb(0 0 0 / .9)", fontFamily: font.sans, color: c.fg, display: "flex", alignItems: "center", gap: 24 }}>
        <span style={{ width: 22, height: 22, flexShrink: 0, borderRadius: "50%", background: c.lime }} />
        <div><div style={{ fontSize: 44, fontWeight: 500 }}>{name}</div><div style={{ fontSize: 32, color: c.mutedFg }}>{status}</div></div>
      </div></Pop>)}
    </Shot>
  </>;
}
