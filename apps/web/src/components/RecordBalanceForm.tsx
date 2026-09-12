"use client";

import * as React from "react";
import { minorDigitsFor } from "@moneo/shared/currencies";
import { toMinorUnits } from "@moneo/shared/money";
import { useState } from "react";
import { createClient, type Account, type BalancePreview } from "../generated/client";

/**
 * Issue 4.10 — explicit manual balance entry with reconciliation preview.
 *
 * The user states the balance, its as-of moment, and the inclusion cutoff
 * (prefilled with the as-of date: everything before counts as included).
 * Preview is read-only and runs before anything is written; recording goes
 * through the audited `accounts.recordBalance` command with a fresh
 * idempotency key per submission, so double-clicks record once.
 */

function majorToMinor(major: string, currencyCode: string): string {
  const text = major.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error("Enter a decimal amount like 1234.56.");
  }
  return toMinorUnits(text, minorDigitsFor(currencyCode)).toString();
}

export function RecordBalanceForm({
  account,
  onRecorded,
  onCancel,
}: {
  account: Account;
  onRecorded: () => void;
  onCancel: () => void;
}) {
  const [client] = useState(() => createClient());
  const [amountMajor, setAmountMajor] = useState("");
  const [asOf, setAsOf] = useState("");
  const [cutoff, setCutoff] = useState("");
  const [preview, setPreview] = useState<BalancePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function runPreview() {
    setError(null);
    try {
      const minor = majorToMinor(amountMajor, account.currencyCode);
      const result = await client.previewBalance(account.id, {
        currentAmountMinor: minor,
        currencyCode: account.currencyCode,
        ...(cutoff ? { cutoffDate: cutoff } : {}),
      });
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
    }
  }

  async function record() {
    setError(null);
    setWorking(true);
    try {
      const minor = majorToMinor(amountMajor, account.currencyCode);
      const observedAt = asOf ? new Date(asOf).toISOString() : new Date().toISOString();
      if (Number.isNaN(Date.parse(observedAt))) {
        throw new Error("Enter a valid as-of date and time.");
      }
      await client.executeCommand("accounts.recordBalance", {
        metadata: { idempotencyKey: crypto.randomUUID() },
        input: {
          accountId: account.id,
          observedAt,
          currentAmountMinor: minor,
          availableAmountMinor: null,
          currencyCode: account.currencyCode,
          source: "manual",
          cutoffDate: cutoff === "" ? null : cutoff,
        },
      });
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <form
      aria-label={`Record balance for ${account.name}`}
      onSubmit={(event) => {
        event.preventDefault();
      }}
      style={{ display: "grid", gap: 8, marginTop: 12 }}
    >
      <label>
        Current balance ({account.currencyCode}){" "}
        <input
          type="text"
          inputMode="decimal"
          value={amountMajor}
          placeholder="e.g. 1234.56"
          onChange={(event) => {
            setAmountMajor(event.target.value);
          }}
        />
      </label>
      <label>
        As of{" "}
        <input
          type="datetime-local"
          value={asOf}
          onChange={(event) => {
            const value = event.target.value;
            setAsOf(value);
            if (value && !cutoff) {
              setCutoff(value.slice(0, 10));
            }
          }}
        />
      </label>
      <label>
        Transactions included through (cutoff, exclusive){" "}
        <input
          type="date"
          value={cutoff}
          onChange={(event) => {
            setCutoff(event.target.value);
          }}
        />
      </label>
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      {preview ? (
        <p aria-live="polite" style={{ margin: 0 }}>
          {preview.unresolved
            ? `Cannot project yet (${preview.reason}).`
            : `Projection: ${preview.applicableCount} later transactions apply.`}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            void runPreview();
          }}
        >
          Preview
        </button>
        <button
          type="button"
          disabled={working}
          onClick={() => {
            void record();
          }}
        >
          {working ? "Recording…" : "Record balance"}
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
