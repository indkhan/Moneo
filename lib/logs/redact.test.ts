import { describe, expect, it } from "vitest";
import { redactEntries, redactText, redactValue, reportText, type LogEntryView } from "./redact";

const entry = (overrides: Partial<LogEntryView>): LogEntryView => ({
  id: "00000000-0000-4000-8000-000000000001", created_at: "2026-11-27T10:00:00.000Z", level: "error", area: "sync", event: "bank.sync",
  message: "failed", details: null, conversation_id: null, usage_id: null, agent_run_id: null, job_id: null, audio_path: null, ...overrides,
});

describe("redactText", () => {
  it("removes IBANs written with or without spaces", () => {
    for (const iban of ["DE89370400440532013000", "DE89 3704 0044 0532 0130 00", "GB29NWBK60161331926819", "FR14 2004 1010 0505 0001 3M02 606"])
      expect(redactText(`sync failed for ${iban} today`)).toBe("sync failed for [iban] today");
  });

  it("removes account and card numbers", () => {
    expect(redactText("account 0532013000 and card 4111 1111 1111 1111")).toBe("account [number] and card [number]");
  });

  it("removes money amounts in common forms", () => {
    for (const amount of ["€1,234.56", "1.234,56 €", "EUR 12", "-42.10", "$ 9.99", "£3", "1 234,56 EUR", "12.50€"])
      expect(redactText(`paid ${amount} at noon`)).toBe("paid [amount] at noon");
  });

  it("removes emails, keys, tokens and bearer headers", () => {
    expect(redactText("owner jane.doe+x@example.co.uk wrote")).toBe("owner [email] wrote");
    expect(redactText("key sk-proj-abcDEF1234567890xyz used")).toBe("key [secret] used");
    expect(redactText(`Authorization: ${["Bear", "er"].join("")} ${"ab".repeat(9)}`)).toBe("Authorization: [secret]");
    expect(redactText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part")).toBe("jwt [secret]");
    expect(redactText("https://x.test/cb?code=1&api_key=s3cr3tvalue&x=1")).toBe("https://x.test/cb?code=1&api_key=[secret]&x=1");
    expect(redactText(`blob ${"a1B2".repeat(10)} end`)).toBe("blob [secret] end");
  });

  it("removes the names Moneo knows, whole words only and ignoring case", () => {
    expect(redactText("Rewe Markt and REWE and Rewetal paid by Jane", ["Rewe", "Rewe Markt", "Jane"])).toBe("[name] and [name] and Rewetal paid by [name]");
  });

  it("removes the owner's user folder from file paths in stack traces", () => {
    expect(redactText(String.raw`at f (C:\Users\jane\Moneo\lib\x.ts:1:2)`)).toBe(String.raw`at f (~\Moneo\lib\x.ts:1:2)`);
    expect(redactText(JSON.stringify({ stack: String.raw`C:\Users\jane\Moneo` }))).toBe(JSON.stringify({ stack: String.raw`~\Moneo` }));
    expect(redactText("at f (c:/Users/jane/Moneo/x.ts) and /home/jane/app and /Users/jane/app")).toBe("at f (~/Moneo/x.ts) and ~/app and ~/app");
  });

  it("keeps ids, timestamps, durations and counts that make a report useful", () => {
    const text = "run 3f2b6c1e-1234-4a5b-9c8d-0123456789ab at 2026-11-27T10:00:00.000Z took 1500 ms, http 502, 12 rows";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactValue", () => {
  it("hides secrets, amounts, names and free text by field name, deep inside details", () => {
    expect(redactValue({
      model: "gpt-6-luna", apiKey: "plain", headers: { Authorization: "x" }, amount_minor: 1234, balance: "10", merchant_name: "Edeka", account: "Giro",
      text: "what did I spend", reasoning: "thinking about it", toolCalls: [{ toolName: "transactions_search", input: { query: "Edeka" } }], durationMs: 1200,
    })).toEqual({
      model: "gpt-6-luna", apiKey: "[secret]", headers: { Authorization: "[secret]" }, amount_minor: "[amount]", balance: "[amount]", merchant_name: "[name]", account: "[name]",
      text: "[text, 16 chars]", reasoning: "[text, 17 chars]", toolCalls: [{ toolName: "transactions_search", input: "[text]" }], durationMs: 1200,
    });
  });

  it("keeps error names, which say what failed and name no one", () => {
    expect(redactValue({ error: { name: "AI_APICallError" }, merchant: { name: "Edeka" } })).toEqual({ error: { name: "AI_APICallError" }, merchant: { name: "[name]" } });
  });

  it("redacts patterns inside string values under neutral keys", () => {
    expect(redactValue({ error: { message: "IBAN DE89370400440532013000 rejected" } })).toEqual({ error: { message: "IBAN [iban] rejected" } });
  });
});

describe("redactEntries", () => {
  it("omits serialized private text from previously truncated log entries", () => {
    const [report] = redactEntries([entry({
      details: { truncated: true, size: 210_000, start: '{"messages":[{"content":"A private sentence' },
    })]);
    expect(report?.details).toEqual({ truncated: true, size: 210_000 });
  });

  it("never includes audio, only says it was left out", () => {
    const [report] = redactEntries([entry({ area: "voice", audio_path: "ws/clip.wav", details: { transcript: "pay Jane 20 euros" } })]);
    expect(report).toMatchObject({ audio: "not included", details: { transcript: "[text, 17 chars]" } });
    expect(JSON.stringify(report)).not.toContain("clip.wav");
  });

  it("produces a text report with no trace of the redacted values", () => {
    const entries = redactEntries([entry({ message: "sync of DE89370400440532013000 for jane@example.com failed at €12.30", details: { token: "abc", note: "Jane" } })], ["Jane"]);
    const text = reportText(entries, "Moneo logs");
    for (const leaked of ["DE89", "jane@", "12.30", "abc", "Jane"]) expect(text).not.toContain(leaked);
    expect(text).toContain("[iban]");
  });
});
