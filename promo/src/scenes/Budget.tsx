import { c, font, money, Pop, ramp, shake, Shot, Slam, SNAP, useB } from "../kit";
import { CUES } from "../timeline";

type Row = { name: string; spent: number; limit: number; note: string; over?: boolean; adds?: number };
// The €42 from the call lands in Eating out, and the notes follow the rules on Moneo's Budgets card.
const ROWS: Row[] = [
  { name: "Groceries", spent: 312, limit: 450, note: "On track" },
  { name: "Eating out", spent: 146, adds: 42, limit: 200, note: "€12.00 left for 9 days" },
  { name: "Going out", spent: 240, limit: 200, note: "€40.00 over", over: true },
  { name: "Travel", spent: 120, limit: 300, note: "€180.00 left · includes €80.00 rolled over" },
];

/** Budgets the size of the whole screen: each row is a progress bar that slams full on a beat. */
export function Budget() {
  const t = useB();
  return <>
    <Slam word="Budget it." />
    <Shot from={1} to={8} flash={0.3}>
      {ROWS.map((row, index) => {
        const at = CUES.budgetBars[index];
        const fill = ramp(t, at, at + 0.8, SNAP);
        const spent = row.spent * fill + (row.adds ?? 0) * ramp(t, CUES.budgetAdd, CUES.budgetAdd + 0.5, SNAP);
        const share = Math.min(100, spent / row.limit * 100);
        const isOver = spent > row.limit;
        const [x, y] = row.over ? shake(t, at + 0.65, 12) : row.adds ? shake(t, CUES.budgetAdd + 0.3, 8) : [0, 0];
        return <div key={row.name} style={{ position: "absolute", left: 0, right: 0, top: index * 270, height: 270, background: index % 2 ? "#16171a" : "#121315", opacity: ramp(t, at - 0.05, at), transform: `translate(${x}px, ${y}px)` }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${share}%`, background: isOver ? c.warning : c.lime }} />
          {/* The same text twice: light on the track, dark where the bar has passed under it. */}
          {[{ color: c.fg, clip: undefined }, { color: c.bg, clip: `inset(0 ${100 - share}% 0 0)` }].map(({ color, clip }) => <div key={color} style={{ position: "absolute", inset: 0, padding: "0 70px", display: "flex", alignItems: "center", justifyContent: "space-between", color, clipPath: clip }}>
            <div>
              <div style={{ fontFamily: font.display, fontSize: 122, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1 }}>{row.name}</div>
              <div style={{ fontFamily: font.sans, fontSize: 42, marginTop: 10, opacity: ramp(t, at + 0.6, at + 0.8) }}>{row.note}</div>
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 70, fontVariantNumeric: "tabular-nums" }}>{money(spent)} / {money(row.limit)}</div>
          </div>)}
        </div>;
      })}
      <Pop at={CUES.budgetAdd} from={0.5} style={{ position: "absolute", left: 640, top: 372, zIndex: 8 }}>
        <div style={{ padding: "16px 34px", borderRadius: 18, background: c.aiSoft, border: `2px solid ${c.ai}`, color: c.ai, fontFamily: font.mono, fontSize: 34, whiteSpace: "nowrap" }}>+€42 from your call</div>
      </Pop>
    </Shot>
  </>;
}
