"use client";
import { useEffect, useState } from "react";
import { Card, CardTitle, Button } from "@moneo/ui";
import { readCsrfToken } from "@/lib/sessions-client";
import { CSRF_HEADER } from "@/lib/csrf";
import { canManageAiSettings } from "./ai-settings-ownership";
type Settings = {
  mode: "included" | "custom";
  model: string;
  models: string[];
  prompt: string;
  defaultPrompt: string;
  policyVersion: number;
  credentialConnected: boolean;
  includedConnected: boolean;
  canManage: boolean;
  accounts: Array<{ id: string; name: string; aiAccess: boolean }>;
  usage: Array<{
    resolvedModel: string | null;
    resolvedProvider: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costMicros: number | null;
    status: string;
  }>;
};
export function AiSettings() {
  const [data, setData] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [apiKey, setApiKey] = useState("");
  async function load() {
    const r = await fetch("/api/v1/ai/settings", { cache: "no-store" });
    const body = (await r.json()) as Settings & { message?: string };
    if (!r.ok)
      throw new Error(body.message ?? "Sign in and complete security setup to configure AI.");
    setData(body);
  }
  useEffect(() => {
    void load().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "AI settings unavailable");
    });
  }, []);
  async function save(body: Record<string, unknown>) {
    if (!canManageAiSettings(data)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/v1/ai/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: readCsrfToken(document.cookie) ?? "",
        },
        body: JSON.stringify({ ...body, expectedVersion: data.policyVersion }),
      });
      const result = (await r.json()) as Settings & { message?: string };
      if (!r.ok) throw new Error(result.message ?? "Could not save AI settings.");
      setData({ ...result, canManage: data.canManage });
      setNotice("AI settings saved. Existing runs were stopped; new requests use this policy.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setBusy(false);
    }
  }
  async function credential(action: "connect" | "test" | "revoke") {
    if (!canManageAiSettings(data)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/v1/ai/credentials", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: readCsrfToken(document.cookie) ?? "",
        },
        body: JSON.stringify({
          action,
          ...(action === "connect" ? { apiKey } : {}),
          expectedVersion: data.policyVersion,
        }),
      });
      const result = (await r.json()) as Settings & { message?: string };
      if (!r.ok) throw new Error(result.message ?? "Provider connection failed.");
      setApiKey("");
      await load();
      setNotice(
        action === "test" ? "OpenRouter connection verified." : "Provider credentials updated.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Provider connection failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardTitle>AI settings</CardTitle>
      <p>
        Grounded finance chat uses OpenRouter free models. Account access applies to every AI
        request.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <a href="/auth/login?prompt=login&max_age=0&returnTo=/settings">Verify your identity</a>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!data ? (
        <Button
          onClick={() =>
            void load().catch((e: unknown) => {
              setError(e instanceof Error ? e.message : "AI settings unavailable");
            })
          }
        >
          Load AI settings
        </Button>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {!canManageAiSettings(data) && (
            <p role="note">
              Only workspace owners can change AI mode, prompts, credentials, or account access. You
              can still review this configuration and recent usage.
            </p>
          )}
          <fieldset disabled={busy || !canManageAiSettings(data)}>
            <legend>AI mode</legend>
            <label>
              <input
                type="radio"
                name="ai-mode"
                checked={data.mode === "included"}
                onChange={() => void save({ mode: "included" })}
              />{" "}
              Included AI
            </label>{" "}
            <label>
              <input
                type="radio"
                name="ai-mode"
                checked={data.mode === "custom"}
                onChange={() => void save({ mode: "custom" })}
              />{" "}
              Custom AI
            </label>
            <p>
              {data.mode === "included"
                ? data.includedConnected
                  ? "Included OpenRouter connection is configured."
                  : "Included AI needs OPENROUTER_API_KEY on the server."
                : data.credentialConnected
                  ? "Your encrypted OpenRouter credential is connected."
                  : "Connect your OpenRouter key below."}
            </p>
          </fieldset>
          <label>
            Financial Assistant model
            <select
              value={data.model}
              disabled={busy || !canManageAiSettings(data) || data.mode === "included"}
              onChange={(e) => void save({ model: e.target.value })}
              style={{ display: "block", maxWidth: "100%" }}
            >
              {data.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            Financial Assistant prompt
            <textarea
              rows={5}
              value={data.prompt}
              readOnly={!canManageAiSettings(data) || data.mode === "included"}
              onChange={(e) => {
                setData({ ...data, prompt: e.target.value });
              }}
              style={{ display: "block", width: "100%", boxSizing: "border-box" }}
            />
          </label>
          {data.mode === "custom" && (
            <>
              <div>
                <Button
                  disabled={busy || !canManageAiSettings(data)}
                  onClick={() => void save({ prompt: data.prompt })}
                >
                  Save prompt
                </Button>{" "}
                <Button
                  disabled={busy || !canManageAiSettings(data)}
                  onClick={() => void save({ restorePrompt: true })}
                >
                  Restore default prompt
                </Button>
              </div>
              <fieldset disabled={busy || !canManageAiSettings(data)}>
                <legend>OpenRouter credential</legend>
                <p>
                  Connecting, rotating or revoking a key requires a recent sign-in. Keys stay
                  encrypted on the server.
                </p>
                <label>
                  API key{" "}
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                    }}
                  />
                </label>{" "}
                <Button disabled={!apiKey.trim()} onClick={() => void credential("connect")}>
                  {data.credentialConnected ? "Rotate key" : "Connect key"}
                </Button>{" "}
                <Button
                  disabled={!data.credentialConnected}
                  onClick={() => void credential("test")}
                >
                  Test connection
                </Button>{" "}
                <Button
                  disabled={!data.credentialConnected}
                  onClick={() => void credential("revoke")}
                >
                  Revoke key
                </Button>
              </fieldset>
            </>
          )}
          <fieldset disabled={busy || !canManageAiSettings(data)}>
            <legend>AI data access</legend>
            <p>
              AI can read eligible accounts, balances and transactions. Excluding an account stops
              subsequent access and invalidates earlier model context. It cannot recall data already
              sent to a provider. Ordinary finance views retain the account.
            </p>
            {data.accounts.length === 0 ? (
              <p>No accounts yet. Import a statement or add a manual account first.</p>
            ) : (
              data.accounts.map((account) => (
                <label key={account.id} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={account.aiAccess}
                    onChange={(e) => {
                      const excluded = data.accounts
                        .filter((a) => (a.id === account.id ? !e.target.checked : !a.aiAccess))
                        .map((a) => a.id);
                      void save({ excludedAccountIds: excluded });
                    }}
                  />{" "}
                  {account.name}
                </label>
              ))
            )}
          </fieldset>
          <details>
            <summary>Recent AI usage ({data.usage.length} calls)</summary>
            {data.usage.length === 0 ? (
              <p>No model calls yet.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Provider</th>
                      <th>Tokens in / out</th>
                      <th>Cost (USD)</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.usage.map((call, index) => (
                      <tr key={index}>
                        <td>{call.resolvedModel ?? "Unavailable"}</td>
                        <td>{call.resolvedProvider ?? "Unavailable"}</td>
                        <td>
                          {call.inputTokens ?? "?"} / {call.outputTokens ?? "?"}
                        </td>
                        <td>
                          {call.costMicros === null
                            ? "Unavailable"
                            : (call.costMicros / 1_000_000).toFixed(6)}
                        </td>
                        <td>{call.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </div>
      )}
    </Card>
  );
}
