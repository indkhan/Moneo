"use client";

import * as React from "react";
import { minorDigitsFor } from "@moneo/shared/currencies";
import { toMinorUnits } from "@moneo/shared/money";
import { useState } from "react";
import { createClient, type Account, type MoneoClient } from "../generated/client";

/**
 * Issue 4.12 — cash transaction entry.
 *
 * Exact money only: the major-unit input converts through the shared
 * minor-unit converter (never a float), and the command validates
 * ownership, currency, and date server-side. The result carries the
 * balance-effect contract: current rows move the projection, older rows
 * change history only — and the form says which happened.
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ManualTransactionForm({
  accounts,
  onRecorded,
  onCancel,
  client,
}: {
  accounts: Account[];
  onRecorded: () => void;
  onCancel: () => void;
  client?: MoneoClient;
}) {
  const [api] = useState(() => client ?? createClient());
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [amountMajor, setAmountMajor] = useState("");
  const [direction, setDirection] = useState<"credit" | "debit">("debit");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];

  async function submit() {
    setError(null);
    setMessage(null);
    if (!account) {
      setError("Choose an account first.");
      return;
    }
    setWorking(true);
    try {
      const text = amountMajor.trim();
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new Error("Enter a decimal amount like 15.00.");
      }
      const minor = toMinorUnits(text, minorDigitsFor(account.currencyCode)).toString();
      const outcome = await api.executeCommand("transactions.createManual", {
        metadata: { idempotencyKey: crypto.randomUUID() },
        input: {
          accountId: account.id,
          effectiveDate: date,
          description: description.trim(),
          amountMinor: minor,
          currencyCode: account.currencyCode,
          direction,
        },
      });
      const result = outcome.result as { affectsProjection?: boolean };
      setMessage(
        result.affectsProjection === true
          ? "Recorded — this moves your current balance."
          : "Recorded in history (before the balance cutoff).",
      );
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the transaction.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <form
      aria-label="Record cash transaction"
      onSubmit={(event) => {
        event.preventDefault();
      }}
      style={{ display: "grid", gap: 8, marginTop: 12 }}
    >
      <label>
        Account{" "}
        <select
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
          }}
        >
          {accounts.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${entry.name} (${entry.currencyCode})`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Date{" "}
        <input
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
          }}
        />
      </label>
      <label>
        Description{" "}
        <input
          type="text"
          value={description}
          placeholder="Cash coffee"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      <label>
        Amount{" "}
        <input
          type="text"
          inputMode="decimal"
          value={amountMajor}
          placeholder="15.00"
          onChange={(event) => {
            setAmountMajor(event.target.value);
          }}
        />
      </label>
      <label>
        Direction{" "}
        <select
          value={direction}
          onChange={(event) => {
            setDirection(event.target.value as "credit" | "debit");
          }}
        >
          <option value="debit">Spent (debit)</option>
          <option value="credit">Received (credit)</option>
        </select>
      </label>
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      {message ? (
        <p aria-live="polite" style={{ margin: 0 }}>
          {message}
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
          {working ? "Recording…" : "Record transaction"}
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
