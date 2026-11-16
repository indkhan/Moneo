import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessages } from "./chat-messages";
import { resendQuestion } from "./message-actions";

const attachment = { name: "statement.pdf", path: "ws/statement.pdf", type: "application/pdf" };
const messages = [
  { id: "q1", role: "user", content: "First question", created_at: "t" },
  { id: "a1", role: "assistant", content: "First answer", created_at: "t" },
  { id: "q2", role: "user", content: "Second question", created_at: "t", attachments: [attachment] },
  { id: "a2", role: "assistant", content: "Second answer", created_at: "t", model: "gpt-test-1" },
];

it("regenerate resends the question behind that reply, with its attachments", () => {
  expect(resendQuestion(messages, 3)).toEqual({ message: "Second question", attachments: [attachment] });
  expect(resendQuestion(messages, 1)).toEqual({ message: "First question", attachments: [] });
});

it("shows the model that produced a reply", () => {
  expect(renderToStaticMarkup(<ChatMessages messages={messages} />)).toContain("gpt-test-1");
});
