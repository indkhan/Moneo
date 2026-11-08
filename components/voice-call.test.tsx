import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceCallView } from "./voice-call";

vi.mock("@/components/iou-card", () => ({ IouCard: () => null }));

const raw = "hey so um can you tell me how much I spent at Netto";
const render = (tasks: { requestId: string; text: string; title?: string; step: string; status: string }[]) => renderToStaticMarkup(<VoiceCallView onClose={() => {}} call={{
  status: "live", error: "", muted: false, toggleMute: () => {}, cancel: async () => {}, levels: () => ({ mic: 0, moneo: 0 }), captions: [], tasks, cards: [], unsaid: new Set(),
  typed: () => {}, thinking: true, talking: false,
} as never} />);
const task = { requestId: "a", text: raw, step: "searching transactions", status: "running" };

it("shows a task by its title, not the user's raw words", () => {
  const html = render([{ ...task, title: "Netto spending" }]);
  expect(html).toContain("Netto spending");
  expect(html).not.toContain(raw);
});

it("holds a placeholder until the title arrives, with the words for a screen reader", () => {
  const html = render([task]);
  expect(html).toContain("animate-pulse");
  expect(html).toContain(`sr-only">${raw}`);
});

it("falls back to the words when a finished task never got a title", () => {
  const html = render([{ ...task, status: "done", step: "answered" }]);
  expect(html).not.toContain("sr-only\">" + raw);
  expect(html).toContain(raw);
});
