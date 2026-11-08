import { c, Card, Cursor, font, lerp, Pop, ramp, shake, Shot, Slam, useB, Big } from "../kit";
import { CUES } from "../timeline";

export function Power() {
  const t = useB();
  const [x, y] = shake(t, CUES.powerSignIn, 16);
  return <>
    <Slam word="Power it." bg={c.ai} />
    <Shot from={1} to={3.5} flash={0.3}>
      <div style={{ position: "absolute", left: "50%", top: "50%", width: 1560, height: 300, marginLeft: -780, marginTop: -150, display: "grid", placeItems: "center", border: `4px solid ${t >= CUES.powerSignIn ? c.lime : c.input}`, borderRadius: 48, background: t >= CUES.powerSignIn ? c.lime : c.card, color: t >= CUES.powerSignIn ? c.bg : c.fg, fontFamily: font.sans, fontSize: 124, fontWeight: 600, letterSpacing: "-0.03em", transform: `translate(${x}px, ${y}px) scale(${t >= CUES.powerSignIn ? lerp(0.95, 1, ramp(t, CUES.powerSignIn, CUES.powerSignIn + 0.4)) : lerp(0.8, 1, ramp(t, 1, 1.5))})` }}>{t >= CUES.powerSignIn ? "You're in." : "Sign in with ChatGPT"}</div>
      <Cursor size={84} path={[{ t: 1.6, x: 1500, y: 960 }, { t: CUES.powerSignIn, x: 960, y: 560 }, { t: 3.5, x: 1040, y: 680 }]} clicks={[CUES.powerSignIn]} />
    </Shot>
    <Shot from={3.5} to={5} flash={0.3}><Big size={210}>Use the plan you <span style={{ color: c.lime, marginLeft: "0.25em" }}>already pay for.</span></Big></Shot>
    <Shot from={5} to={8} flash={0.3}>
      <Big size={96} style={{ alignItems: "flex-start", paddingTop: 80 }}>Or bring your own key.</Big>
      <div style={{ position: "absolute", left: 90, right: 90, top: 240, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30 }}>
        <Pop at={5.1} from={0.8}><Card style={{ height: 720, padding: 54, borderRadius: 32, border: `3px solid ${c.fg}` }}>
          <div style={{ fontSize: 60, fontWeight: 500 }}>ChatGPT plan</div><div style={{ fontSize: 42, color: c.mutedFg }}>in use</div>
          <div style={{ fontSize: 50, lineHeight: 1.25, color: c.mutedFg, marginTop: 50 }}>Signed in. Requests count toward your plan's limits.</div>
        </Card></Pop>
        <Pop at={5.6} from={0.8}><Card style={{ height: 720, padding: 54, borderRadius: 32 }}>
          <div style={{ fontSize: 60, fontWeight: 500 }}>OpenAI API key</div>
          <div style={{ fontSize: 50, lineHeight: 1.25, color: c.mutedFg, marginTop: 50 }}>Usage is billed to the key. Also needed for voice calls and dictation.</div>
          <div style={{ marginTop: 56, height: 120, padding: "0 34px", border: `2px solid ${c.input}`, borderRadius: 20, display: "flex", alignItems: "center", fontFamily: font.mono, fontSize: 50, color: c.subtle }}>sk-…</div>
        </Card></Pop>
      </div>
    </Shot>
  </>;
}
