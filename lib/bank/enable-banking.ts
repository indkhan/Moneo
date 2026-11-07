import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { serviceKey } from "@/lib/service-keys";

// Enable Banking REST client (https://enablebanking.com/docs/api/reference/).
// Auth is a short-lived RS256 JWT signed with the app's private key; there are no refresh tokens.

const amountSchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.string().regex(/^-?\d+(?:\.\d+)?$/) });

const aspspSchema = z.object({
  name: z.string().min(1).max(200),
  country: z.string().regex(/^[A-Z]{2}$/),
  logo: z.string().url().optional().nullable(),
  maximum_consent_validity: z.number().int().positive().optional().nullable(),
  psu_types: z.array(z.string()).optional(),
});
export type Aspsp = z.infer<typeof aspspSchema>;

const accountSchema = z.object({
  uid: z.string().min(1).max(200),
  account_id: z.object({ iban: z.string().max(34).optional().nullable() }).passthrough().optional().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  name: z.string().max(200).optional().nullable(),
  product: z.string().max(200).optional().nullable(),
}).passthrough();
export type BankAccount = z.infer<typeof accountSchema>;

const sessionSchema = z.object({
  session_id: z.string().min(1).max(500),
  accounts: z.array(accountSchema).max(100),
  aspsp: z.object({ name: z.string(), country: z.string() }),
  access: z.object({ valid_until: z.string().datetime({ offset: true }) }),
});

const balanceSchema = z.object({
  balance_amount: amountSchema,
  balance_type: z.string().max(10),
  reference_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});
export type BankBalance = z.infer<typeof balanceSchema>;

const partySchema = z.object({ name: z.string().max(500).optional().nullable() }).passthrough().optional().nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable();
export const bankTransactionSchema = z.object({
  entry_reference: z.string().max(500).optional().nullable(),
  transaction_id: z.string().max(500).optional().nullable(),
  transaction_amount: amountSchema,
  credit_debit_indicator: z.enum(["CRDT", "DBIT"]).optional().nullable(),
  status: z.string().max(10),
  booking_date: isoDate,
  value_date: isoDate,
  transaction_date: isoDate,
  creditor: partySchema,
  debtor: partySchema,
  creditor_account: z.object({ iban: z.string().max(34).optional().nullable() }).passthrough().optional().nullable(),
  debtor_account: z.object({ iban: z.string().max(34).optional().nullable() }).passthrough().optional().nullable(),
  remittance_information: z.array(z.string().max(1000)).max(50).optional().nullable(),
  balance_after_transaction: amountSchema.optional().nullable(),
}).passthrough();
export type BankTransaction = z.infer<typeof bankTransactionSchema>;

export class EnableBankingError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); }
  // Consent ended at the bank or Enable Banking: the user must reconnect.
  get expired() { return this.status === 401 || /EXPIRED|REVOKED|CLOSED|INVALID_SESSION/i.test(this.code ?? ""); }
  get rateLimited() { return this.status === 429; }
}

export type EnableBankingCredentials = { appId: string; privateKey: string };
const apiUrl = () => z.string().url().default("https://api.enablebanking.com").parse(process.env.ENABLE_BANKING_API_URL || undefined);

// The App ID and key the owner saved under Import → Connected banks, else the legacy .env pair.
async function credentials(): Promise<EnableBankingCredentials | null> {
  const [appId, privateKey] = await Promise.all([serviceKey("enable_banking_app_id"), serviceKey("enable_banking_private_key")]);
  return appId && privateKey ? { appId, privateKey } : null;
}

export async function enableBankingConfigured() {
  return !!process.env.BANK_TOKEN_ENCRYPTION_KEY && !!(await credentials());
}

// RS256 JWT with the app id as kid. Enable Banking accepts at most 24h; one hour is plenty per request.
export function signJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ typ: "JWT", alg: "RS256", kid: appId })}.${encode({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 })}`;
  // Env files often carry the PEM on one line with literal \n.
  const key = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

// PSU headers mark a request as user-present, so it doesn't count against the ~4/day background limit.
export type PsuContext = { ip: string; userAgent: string };

export async function enableBankingClient(fetcher: typeof fetch = fetch) {
  const saved = await credentials();
  if (!saved) throw new Error("Enable Banking is not set up. Add the App ID and private key under Import → Connected banks.");
  return clientFor(saved, fetcher);
}

/** Checks a pasted App ID and key before they are saved: a bad PEM fails locally, a wrong pair at Enable Banking. */
export async function checkEnableBankingCredentials(input: EnableBankingCredentials, fetcher: typeof fetch = fetch) {
  try { signJwt(input.appId, input.privateKey); } catch { throw new EnableBankingError(0, "INVALID_PRIVATE_KEY", "That private key could not be read"); }
  await clientFor(input, fetcher).application();
}

function clientFor({ appId, privateKey }: EnableBankingCredentials, fetcher: typeof fetch) {
  const base = apiUrl();
  async function call<T>(schema: z.ZodType<T>, method: string, path: string, options: { body?: unknown; psu?: PsuContext } = {}): Promise<T> {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${signJwt(appId, privateKey)}`,
        "content-type": "application/json",
        ...(options.psu ? { "psu-ip-address": options.psu.ip, "psu-user-agent": options.psu.userAgent } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: unknown = {};
    try { if (text) json = JSON.parse(text); } catch { json = undefined; }
    if (!response.ok) {
      const error = z.object({ error: z.string().optional(), code: z.union([z.string(), z.number()]).optional(), message: z.string().optional() }).passthrough().safeParse(json);
      const code = error.success ? String(error.data.error ?? error.data.code ?? "") || undefined : undefined;
      throw new EnableBankingError(response.status, code, `Enable Banking ${method} ${path.split("?")[0]} failed (${response.status}${code ? ` ${code}` : ""})`);
    }
    return schema.parse(json);
  }

  return {
    application: () => call(z.unknown(), "GET", "/application"),
    listAspsps: async (country: string) =>
      (await call(z.object({ aspsps: z.array(aspspSchema) }), "GET", `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`)).aspsps,
    startAuthorization: (input: { aspsp: { name: string; country: string }; validUntil: Date; state: string; redirectUrl: string; psu?: PsuContext }) =>
      call(z.object({ url: z.string().url(), authorization_id: z.string().optional() }), "POST", "/auth", {
        body: { access: { valid_until: input.validUntil.toISOString() }, aspsp: input.aspsp, state: input.state, redirect_url: input.redirectUrl, psu_type: "personal" },
        psu: input.psu,
      }),
    createSession: (code: string, psu?: PsuContext) => call(sessionSchema, "POST", "/sessions", { body: { code }, psu }),
    deleteSession: (sessionId: string, psu?: PsuContext) => call(z.unknown(), "DELETE", `/sessions/${encodeURIComponent(sessionId)}`, { psu }),
    balances: async (accountUid: string, psu?: PsuContext) =>
      (await call(z.object({ balances: z.array(balanceSchema) }), "GET", `/accounts/${encodeURIComponent(accountUid)}/balances`, { psu })).balances,
    // Booked only: pending rows have unstable ids (issue #82). Follows continuation_key to the end.
    bookedTransactions: async (accountUid: string, dateFrom: string, psu?: PsuContext) => {
      const page = z.object({ transactions: z.array(bankTransactionSchema), continuation_key: z.string().optional().nullable() });
      const all: BankTransaction[] = [];
      let continuation: string | undefined;
      for (let pages = 0; pages < 100; pages++) {
        const query = new URLSearchParams({ date_from: dateFrom, transaction_status: "BOOK", ...(continuation ? { continuation_key: continuation } : {}) });
        const result = await call(page, "GET", `/accounts/${encodeURIComponent(accountUid)}/transactions?${query}`, { psu });
        all.push(...result.transactions);
        if (!result.continuation_key) return all;
        continuation = result.continuation_key;
      }
      throw new Error("Enable Banking returned more than 100 transaction pages");
    },
  };
}
export type EnableBankingClient = ReturnType<typeof clientFor>;
