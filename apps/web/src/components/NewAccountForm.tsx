"use client";

import * as React from "react";
import { CURRENCIES } from "@moneo/shared/currencies";
import { useState } from "react";
import { createClient, type MoneoClient } from "../generated/client";

/**
 * Issue 4.12 — manual account entry (e.g. a cash wallet).
 *
 * Names may repeat (two "Cash" wallets are legitimate): retry safety comes
 * from a fresh idempotency key per submission, never from a name rule.
 * Recording goes through the audited `accounts.createManual` command.
 */

const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CASH", "CREDIT", "INVESTMENT", "WALLET", "OTHER"];

export function NewAccountForm({
  onCreated,
  onCancel,
  client,
}: {
  onCreated: () => void;
  onCancel: () => void;
  client?: MoneoClient;
}) {
  const [api] = useState(() => client ?? createClient());
  const [name, setName] = useState("");
  const [currencyCode, setCurrencyCode] = useState("EUR");
  const [accountType, setAccountType] = useState("CASH");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit() {
    setError(null);
    setWorking(true);
    try {
      await api.executeCommand("accounts.createManual", {
        metadata: { idempotencyKey: crypto.randomUUID() },
        input: { name: name.trim(), currencyCode, accountType },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <form
      aria-label="New manual account"
      onSubmit={(event) => {
        event.preventDefault();
      }}
      style={{ display: "grid", gap: 8, marginTop: 12 }}
    >
      <label>
        Name{" "}
        <input
          type="text"
          value={name}
          placeholder="Cash wallet"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <label>
        Currency{" "}
        <select
          value={currencyCode}
          onChange={(event) => {
            setCurrencyCode(event.target.value);
          }}
        >
          {CURRENCIES.map((currency) => (
            <option key={currency.code} value={currency.code}>
              {`${currency.code} — ${currency.name}`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Type{" "}
        <select
          value={accountType}
          onChange={(event) => {
            setAccountType(event.target.value);
          }}
        >
          {ACCOUNT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          disabled={working}
          onClick={() => {
            void submit();
          }}
        >
          {working ? "Creating…" : "Create account"}
        </button>
        <button
          type="button"
          onClick={() => {
            onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
