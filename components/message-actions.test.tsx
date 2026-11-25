import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessages, type ChatItem } from "./chat-messages";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import { visiblePath, type ChatNode } from "@/lib/ai/chat-tree";
import { editOf, regenerateOf } from "./message-actions";

const attachment: ChatAttachment = { name: "statement.pdf", path: "ws/statement.pdf", type: "application/pdf" };
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const nodes: ChatNode[] = [
  { id: "r1", parent: null, regenerates: null, created_at: at(1) },
  { id: "r2", parent: "r1", regenerates: null, created_at: at(2) },
  { id: "r2b", parent: "r1", regenerates: "r2", created_at: at(3) },
];
const messages: ChatItem[] = [
  { id: "q1", role: "user", content: "First question", created_at: at(1), request: "r1" },
  { id: "a1", role: "assistant", content: "First answer", created_at: at(1), request: "r1", answer_of: "r1" },
  { id: "q2", role: "user", content: "Second question", created_at: at(2), attachments: [attachment], request: "r2" },
  { id: "a2", role: "assistant", content: "Second answer", created_at: at(2), request: "r2", answer_of: "r2" },
  { id: "a2b", role: "assistant", content: "Better answer", created_at: at(3), request: "r2b", answer_of: "r2", model: "gpt-test-1" },
];

it("regenerates and edits a question in place, keeping its attachments and where it was asked", () => {
  const [, second] = visiblePath(nodes);
  expect(regenerateOf(second, messages[2])).toEqual({ message: "Second question", attachments: [attachment], spoken: false, after: "r1", regenerates: "r2" });
  expect(editOf(second, messages[2], "Changed question")).toEqual({ message: "Changed question", attachments: [attachment], spoken: false, after: "r1", edits: "r2" });
});

it("shows only the chosen reply of a regenerated question, with the model that wrote it", () => {
  const html = renderToStaticMarkup(<ChatMessages messages={messages} path={visiblePath(nodes)} />);
  expect(html).toContain("gpt-test-1");
  expect(html).not.toContain("Second answer");
  expect(html.match(/Second question/g)).toHaveLength(1);
});
