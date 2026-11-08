import { c, Card, Cursor, Eyebrow, font, lerp, Pop, ramp, Shot, Slam, smoothPath, SNAP, useB, whole } from "../kit";
import { CUES } from "../timeline";

const MONTHS = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"];
// Expected cash each month. June is the €3,180 Moneo quoted on the call, after Lisbon.
const EXPECTED = [6420, 5900, 5200, 5650, 6100, 6400, 4980, 3180, 3900, 4600, 5300, 6000, 6700];
const X = (index: number) => 90 + index * (1740 / (EXPECTED.length - 1));
const Y = (value: number) => 930 - value / 11000 * 720;

/** The camera rides the tip of the forecast line through the year, then pulls out for the what-if. */
export function Plan() {
  const t = useB();
  const progress = ramp(t, 1, 5, x => x) * (EXPECTED.length - 1);
  const index = Math.min(EXPECTED.length - 2, Math.floor(progress)), part = progress - index;
  const tipValue = lerp(EXPECTED[index], EXPECTED[index + 1], part);
  const tipX = lerp(X(index), X(index + 1), part), tipY = Y(tipValue);
  const pull = ramp(t, 5, 5.75, SNAP);
  const zoom = lerp(2.7, 1, pull), camX = lerp(tipX, 960, pull), camY = lerp(tipY, 540, pull);
  const lift = ramp(t, CUES.planLift, CUES.planLift + 1.75, SNAP);
  const extra = 200 * lift;
  const shifted = EXPECTED.map((value, month) => value + extra * month);
  const line = smoothPath(shifted.map((value, month) => [X(month), Y(value)]));
  const base = smoothPath(EXPECTED.map((value, month) => [X(month), Y(value)]));
  const band = (sign: number) => shifted.map((value, month): [number, number] => [X(month), Y(value + sign * month * 170)]);
  const lower = band(-1).reverse();
  const bandPath = `${smoothPath(band(1))}L${lower[0][0]},${lower[0][1]}${smoothPath(lower).replace(/^M[^C]+/, "")}Z`;
  const shown = pull > 0 ? shifted.at(-1)! : tipValue;
  const label = pull > 0 ? "Nov 2027" : `${MONTHS[Math.round(progress)]} ${progress < 1.5 ? 2026 : 2027}`;
  const thumb = lift * 100;
  return <>
    <Slam word="Plan it." bg={c.fg} />
    <Shot from={1} to={10} flash={0.3}>
      <svg viewBox="0 0 1920 1080" width="1920" height="1080" style={{ position: "absolute", inset: 0, transformOrigin: "0 0", transform: `translate(960px, 540px) scale(${zoom}) translate(${-camX}px, ${-camY}px)` }}>
        <defs><clipPath id="tip"><rect x="0" y="0" width={pull > 0 ? 1920 : tipX} height="1080" /></clipPath></defs>
        {MONTHS.map((month, i) => <g key={i}><line x1={X(i)} x2={X(i)} y1="210" y2="930" stroke={c.border} strokeWidth="1.5" /><text x={X(i)} y="972" textAnchor="middle" fill={c.subtle} fontFamily={font.mono} fontSize="24">{month}</text></g>)}
        <g clipPath="url(#tip)">
          <path d={bandPath} fill={c.lime} opacity=".1" />
          {extra > 0 && <path d={base} fill="none" stroke={c.chartOut} strokeWidth="4" strokeDasharray="10 12" />}
          <path d={line} fill="none" stroke={c.lime} strokeWidth="7" strokeLinecap="round" />
          <circle cx={X(7)} cy={Y(shifted[7])} r="12" fill={c.bg} stroke={c.lime} strokeWidth="5" />
        </g>
        {pull === 0 && <circle cx={tipX} cy={tipY} r="11" fill={c.lime} />}
        <text x={X(7)} y={Y(shifted[7]) + 62} textAnchor="middle" fill={c.fg} fontFamily={font.sans} fontSize="36" fontWeight="500" opacity={progress > 7 ? 1 : 0}>Lisbon −€1,800</text>
      </svg>
      <div style={{ position: "absolute", left: 90, top: 56, fontFamily: font.sans, color: c.fg, textShadow: "0 4px 30px #0f1011" }}>
        <Eyebrow style={{ fontSize: 40, color: c.mutedFg }}>Expected · {label}</Eyebrow>
        <div style={{ fontFamily: font.display, fontSize: 170, lineHeight: 1.05, fontWeight: 600, letterSpacing: "-0.045em", fontVariantNumeric: "tabular-nums", color: lift > 0 ? c.lime : c.fg }}>{whole(shown)}</div>
      </div>
      <Pop at={5.75} from={0.8} style={{ position: "absolute", right: 90, top: 56, width: 780 }}>
        <Card style={{ background: c.aiSoft, borderColor: c.ai, padding: 40, borderRadius: 28 }}>
          <div style={{ fontSize: 46, lineHeight: 1.15, fontWeight: 500 }}>What if I save <span style={{ fontFamily: font.mono, color: c.lime }}>{whole(extra)}</span> more a month?</div>
          <div style={{ position: "relative", height: 16, marginTop: 44, marginBottom: 12, borderRadius: 99, background: c.input }}>
            <div style={{ width: `${thumb}%`, height: "100%", background: c.lime, borderRadius: 99 }} />
            <div style={{ position: "absolute", left: `${thumb}%`, top: -22, marginLeft: -30, width: 60, height: 60, borderRadius: "50%", background: c.fg, boxShadow: "0 4px 14px rgb(0 0 0 / .5)" }} />
          </div>
        </Card>
      </Pop>
      <Cursor size={64} path={[{ t: 6, x: 1500, y: 620 }, { t: CUES.planLift, x: 1190, y: 244 }, { t: CUES.planLift + 1.75, x: 1790, y: 244 }]} clicks={[CUES.planLift]} />
    </Shot>
  </>;
}
