import { ArrowLeftRight, Bell, Bot, Coins, Command, FileSpreadsheet, ListChecks, MoonStar, Repeat, SearchCheck, Smartphone, Undo2, type LucideIcon } from "lucide-react";
import { c, Camera, font, ramp, Shot, useB } from "../kit";
import { CUES } from "../timeline";

const TILES: [LucideIcon, string, string][] = [
  [ArrowLeftRight, "Bank sync", "EU banks, every day"],
  [FileSpreadsheet, "Import", "CSV and Excel"],
  [Repeat, "Recurring", "Bills and subscriptions"],
  [Bot, "Agents", "Reviews you accept"],
  [SearchCheck, "Investigations", "Track down any money"],
  [Undo2, "Undo", "Imports roll right back"],
  [Coins, "Currencies", "Every one you hold"],
  [Smartphone, "Phone and tablet", "Private, over Tailscale"],
  [Bell, "Summaries", "Written on a schedule"],
  [ListChecks, "Activity log", "All the AI did"],
  [Command, "Command palette", "Ctrl K, anywhere"],
  [MoonStar, "Light and dark", "Both done properly"],
];
const CELL_W = 445, CELL_H = 320, GAP = 20, LEFT = 60, TOP = 40;
const centre = (index: number) => ({ x: LEFT + (index % 4) * (CELL_W + GAP) + CELL_W / 2, y: TOP + Math.floor(index / 4) * (CELL_H + GAP) + CELL_H / 2 });

/** The camera jumps across a wall of features, one every half beat, then pulls back to show all of it. */
export function Everything() {
  const t = useB();
  const keys = [...TILES.map((_, index) => ({ b: index * CUES.everythingStep, ...centre(index), z: 3.6, d: 0.22 })), { b: 6, x: 960, y: 540, z: 1, d: 0.7 }];
  // The last tile flips the whole picture to light for its half beat.
  const flipped = t >= 11 * CUES.everythingStep && t < 12 * CUES.everythingStep;
  return <Shot from={0} to={8} flash={0.7} style={flipped ? { filter: "invert(1) hue-rotate(180deg)" } : undefined}>
    <Camera keys={keys}>
      {TILES.map(([Icon, title, line], index) => {
        const at = index * CUES.everythingStep;
        const lit = t >= at && t < at + CUES.everythingStep + 0.1;
        const seen = ramp(t, at, at + 0.1);
        const { x, y } = centre(index);
        return <div key={title} style={{ position: "absolute", left: x - CELL_W / 2, top: y - CELL_H / 2, width: CELL_W, height: CELL_H, padding: 28, display: "flex", flexDirection: "column", justifyContent: "space-between", borderRadius: 22, fontFamily: font.sans, background: lit ? c.lime : c.card, color: lit ? c.bg : c.fg, border: `1px solid ${c.border}`, opacity: 0.25 + seen * 0.75 }}>
          <Icon size={56} strokeWidth={1.5} color={lit ? c.bg : c.lime} />
          <div><div style={{ fontFamily: font.display, fontSize: 48, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.03 }}>{title}</div><div style={{ fontSize: 28, marginTop: 8, color: lit ? c.bg : c.mutedFg }}>{line}</div></div>
        </div>;
      })}
    </Camera>
  </Shot>;
}
