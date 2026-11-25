import { describe, expect, it } from "vitest";
import { firstRun } from "./first-run";

const empty = { ai: false, aiSkipped: false, money: false, transactions: false, agentRan: false };

describe("firstRun", () => {
  it("shows AI and money but not the agent team in an empty workspace, and keeps Customize off", () =>
    expect(firstRun(empty)).toEqual({ show: true, ai: "todo", money: false, agents: null, canCustomize: false }));

  it("keeps asking for money after AI is skipped", () =>
    expect(firstRun({ ...empty, aiSkipped: true })).toEqual({ show: true, ai: "skipped", money: false, agents: null, canCustomize: false }));

  it("asks for money when AI is on and nothing is imported", () =>
    expect(firstRun({ ...empty, ai: true })).toMatchObject({ show: true, ai: "on", money: false, agents: null }));

  it("offers the agent team once transactions exist, even before AI is on", () =>
    expect(firstRun({ ...empty, money: true, transactions: true })).toEqual({ show: true, ai: "todo", money: true, agents: { done: false }, canCustomize: true }));

  it("leaves the agent team out when AI was skipped, so the checklist can finish", () =>
    expect(firstRun({ ...empty, aiSkipped: true, money: true, transactions: true })).toMatchObject({ show: false, agents: null }));

  it("does not offer the agent team for accounts without transactions", () =>
    expect(firstRun({ ...empty, ai: true, money: true })).toMatchObject({ show: false, agents: null }));

  it("stays until the agent team has run, then hides", () => {
    const ready = { ...empty, ai: true, money: true, transactions: true };
    expect(firstRun(ready).show).toBe(true);
    expect(firstRun({ ...ready, agentRan: true })).toEqual({ show: false, ai: "on", money: true, agents: { done: true }, canCustomize: true });
  });
});
