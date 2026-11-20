import { describe, expect, it } from "vitest";
import { memoryBrief, type MemoryRow } from "./memory";

const today = "2026-11-20";
let next = 0;
const memory = (fields: Partial<MemoryRow>): MemoryRow => ({
  id: `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`, kind: "fact", statement: "Synthetic fact", quote: "synthetic", status: "active",
  valid_from: null, valid_until: null, ended_on: null, replaces: null, conversation_id: null, saved_by: "ai", created_at: "2026-11-01T10:00:00Z", closed_at: null, ...fields,
});

describe("memoryBrief", () => {
  it("tells the assistant only what is true now, so replaced, ended, expired and far-off memories never read as current", () => {
    const brief = memoryBrief([
      memory({ statement: "Partner pays half the rent", status: "replaced", closed_at: "2026-11-10T10:00:00Z" }),
      memory({ statement: "Partner pays all of the rent" }),
      memory({ statement: "Freelancing", status: "ended", closed_at: "2026-11-12T10:00:00Z" }),
      memory({ kind: "pledge", statement: "No takeout this month", valid_until: "2026-10-31" }),
      memory({ kind: "plan", statement: "Moving to Berlin", valid_from: "2027-06-01" }),
      memory({ kind: "plan", statement: "Car insurance rises", valid_from: "2027-01-01" }),
      memory({ statement: "Waiting for the owner", status: "suggested" }),
    ], today);
    expect(brief.text).toContain("Partner pays all of the rent");
    expect(brief.text).toContain("Car insurance rises");
    for (const stale of ["half the rent", "Freelancing", "No takeout", "Berlin", "Waiting for the owner"]) expect(brief.text).not.toContain(stale);
  });

  it("keeps preferences and pledges when a long history would overflow the prompt, and says how many were left out", () => {
    const facts = Array.from({ length: 200 }, (_, index) => memory({ statement: `Background fact number ${index} about the owner's life and spending` }));
    const brief = memoryBrief([...facts, memory({ kind: "pledge", statement: "Cutting out food delivery" }), memory({ kind: "preference", statement: "Be blunt" })], today, 2000);
    expect(brief.text.length).toBeLessThanOrEqual(2200);
    expect(brief.text).toContain("Be blunt");
    expect(brief.text).toContain("Cutting out food delivery");
    expect(brief.text).toMatch(/\n\d+ more: use memory_search$/);
  });
});
