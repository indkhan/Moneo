import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessages, type ChatItem } from "./chat-messages";
import type { ChatAttachment } from "@/lib/ai/chat-attachments";
import { answerGroups, resendQuestion } from "./message-actions";

const attachment: ChatAttachment = { name: "statement.pdf", path: "ws/statement.pdf", type: "application/pdf" };
const messages: ChatItem[] = [
  { id: "q1", role: "user", content: "First question", created_at: "t" },
  { id: "a1", role: "assistant", content: "First answer", created_at: "t", answer_of: "r1" },
  { id: "q2", role: "user", content: "Second question", created_at: "t", attachments: [attachment] },
  { id: "a2", role: "assistant", content: "Second answer", created_at: "t", model: "gpt-test-1", answer_of: "r2" },
];

it("regenerate replaces the reply to the question behind it, with its attachments", () => {
  expect(resendQuestion(messages, 3)).toEqual({ message: "Second question", attachments: [attachment], spoken: false, regenerates: "r2" });
  expect(resendQuestion(messages, 1)).toEqual({ message: "First question", attachments: [], spoken: false, regenerates: "r1" });
});

it("offers no regenerate for a reply that has no saved request", () => {
  expect(resendQuestion([messages[0], { ...messages[1], answer_of: undefined }], 1)).toBeNull();
});

it("keeps every answer to one question together, newest last, even after steering", () => {
  const regenerated: ChatItem[] = [...messages.slice(0, 3), { id: "a2", role: "assistant", content: "Second answer", created_at: "t", answer_of: "r2" },
    { id: "steer", role: "user", content: "Use euros", created_at: "t" }, { id: "a2b", role: "assistant", content: "Better answer", created_at: "t", answer_of: "r2" }];
  expect(answerGroups(regenerated).map(group => group.map(item => item.id))).toEqual([["q1"], ["a1"], ["q2"], ["steer"], ["a2", "a2b"]]);
});

it("shows the model that produced a reply", () => {
  expect(renderToStaticMarkup(<ChatMessages messages={messages} />)).toContain("gpt-test-1");
});
