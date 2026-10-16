import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnableBankingError, enableBankingClient, signJwt } from "./enable-banking";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("signJwt", () => {
  it("signs an RS256 token Enable Banking can verify", () => {
    const token = signJwt("app-1", pem, 1_000);
    const [header, payload, signature] = token.split(".");
    expect(decode(header)).toEqual({ typ: "JWT", alg: "RS256", kid: "app-1" });
    expect(decode(payload)).toEqual({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: 1_000, exp: 4_600 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("accepts a PEM with escaped newlines from an env file", () => {
    expect(signJwt("app-1", pem.replace(/\n/g, "\\n"), 1_000)).toBe(signJwt("app-1", pem, 1_000));
  });
});

describe("enableBankingClient", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_BANKING_APP_ID", "app-1");
    vi.stubEnv("ENABLE_BANKING_PRIVATE_KEY", pem);
    vi.stubEnv("ENABLE_BANKING_API_URL", "https://eb.test");
  });
  afterEach(() => vi.unstubAllEnvs());
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("lists banks with a signed bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ aspsps: [{ name: "Revolut", country: "DE", maximum_consent_validity: 15_552_000 }] }));
    const banks = await enableBankingClient(fetcher).listAspsps("DE");
    expect(banks[0].name).toBe("Revolut");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://eb.test/aspsps?country=DE&psu_type=personal");
    expect(init.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("starts authorization and creates a session with PSU headers", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply({ url: "https://bank.test/consent", authorization_id: "a1" }))
      .mockResolvedValueOnce(reply({ session_id: "s1", aspsp: { name: "Revolut", country: "DE" }, access: { valid_until: "2027-04-14T00:00:00+00:00" },
        accounts: [{ uid: "u1", currency: "EUR", account_id: { iban: "DE00123" }, name: "Main" }] }));
    const client = enableBankingClient(fetcher);
    const psu = { ip: "1.2.3.4", userAgent: "test" };
    await client.startAuthorization({ aspsp: { name: "Revolut", country: "DE" }, validUntil: new Date("2027-04-14T00:00:00Z"), state: "st", redirectUrl: "http://localhost:3000/api/bank/callback", psu });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ access: { valid_until: "2027-04-14T00:00:00.000Z" }, aspsp: { name: "Revolut", country: "DE" },
      state: "st", redirect_url: "http://localhost:3000/api/bank/callback", psu_type: "personal" });
    expect(fetcher.mock.calls[0][1].headers["psu-ip-address"]).toBe("1.2.3.4");
    const session = await client.createSession("code", psu);
    expect(session.accounts[0].uid).toBe("u1");
  });

  it("follows continuation keys for booked transactions", async () => {
    const tx = (id: string) => ({ entry_reference: id, transaction_amount: { currency: "EUR", amount: "1.00" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-10-01" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply({ transactions: [tx("a")], continuation_key: "next" }))
      .mockResolvedValueOnce(reply({ transactions: [tx("b")], continuation_key: null }));
    const rows = await enableBankingClient(fetcher).bookedTransactions("u1", "2026-09-01");
    expect(rows.map(row => row.entry_reference)).toEqual(["a", "b"]);
    expect(fetcher.mock.calls[0][0]).toBe("https://eb.test/accounts/u1/transactions?date_from=2026-09-01&transaction_status=BOOK");
    expect(fetcher.mock.calls[1][0]).toContain("continuation_key=next");
  });

  it("validates responses and classifies errors", async () => {
    await expect(enableBankingClient(vi.fn().mockResolvedValue(reply({ balances: [{ balance_amount: { currency: "EUR", amount: "1,00" }, balance_type: "CLBD" }] }))).balances("u1"))
      .rejects.toThrow();
    const expired = await enableBankingClient(vi.fn().mockResolvedValue(reply({ error: "EXPIRED_SESSION" }, 400))).balances("u1").catch(error => error);
    expect(expired).toBeInstanceOf(EnableBankingError);
    expect(expired.expired).toBe(true);
    const limited = await enableBankingClient(vi.fn().mockResolvedValue(new Response("<html>", { status: 429 }))).balances("u1").catch(error => error);
    expect(limited.rateLimited).toBe(true);
  });
});
