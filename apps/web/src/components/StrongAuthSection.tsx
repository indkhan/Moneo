"use client";

import { useState } from "react";
import { readCsrfToken } from "@/lib/sessions-client";
import {
  fetchStrongAuthStatus,
  requestEnrollmentTicket,
  type StrongAuthStatusBody,
} from "@/lib/strong-auth-client";

/**
 * Issue 1.8 — Settings → Privacy & Security strong-authentication section.
 *
 * Enrollment status, resumable provider-hosted setup (passkey where offered,
 * TOTP fallback), recovery guidance, and an explicit degraded banner.
 * Recovery and factor replacement always run through the provider's
 * protected flows — this UI only links and explains.
 */
export function StrongAuthSection({ initialStatus }: { initialStatus: StrongAuthStatusBody }) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function refresh() {
    setStatus(await fetchStrongAuthStatus(globalThis.fetch));
  }

  async function setup(kind: "passkey" | "totp") {
    setError(null);
    setPending(kind);
    try {
      const { ticketUrl } = await requestEnrollmentTicket(
        globalThis.fetch,
        readCsrfToken(document.cookie),
        kind,
      );
      window.location.assign(ticketUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup could not start — please try again.");
      setPending(null);
    }
  }

  async function recheck() {
    setError(null);
    setPending("recheck");
    try {
      await refresh();
    } catch {
      setError("Could not reach the verification service — access stays locked.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ margin: 0 }}>
        Status:{" "}
        <strong>
          {status.state === "enrolled" && `Enrolled${status.method ? ` via ${status.method}` : ""}`}
          {status.state === "not-enrolled" && "Not enrolled"}
          {status.state === "degraded" && "Unavailable — access locked"}
          {status.state === "signed-out" && "Signed out"}
        </strong>
      </p>

      {status.state === "degraded" && (
        <p role="alert" style={{ color: "#f85149", margin: 0 }}>
          The authentication service could not be reached. Finance access stays locked until
          verification succeeds — nothing is silently downgraded.
        </p>
      )}

      {(status.state === "not-enrolled" || status.state === "degraded") && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {status.passkeysOffered && (
            <button type="button" disabled={pending !== null} onClick={() => void setup("passkey")}>
              {pending === "passkey" ? "Starting…" : "Set up a passkey"}
            </button>
          )}
          <button type="button" disabled={pending !== null} onClick={() => void setup("totp")}>
            {pending === "totp"
              ? "Starting…"
              : status.passkeysOffered
                ? "Use authenticator app instead"
                : "Set up authenticator app"}
          </button>
          <button type="button" disabled={pending !== null} onClick={() => void recheck()}>
            {pending === "recheck" ? "Checking…" : "I already enrolled — check again"}
          </button>
        </div>
      )}

      {status.state === "enrolled" && (
        <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
          {status.factors.map((f) => (
            <li key={f.id}>
              {f.kind}
              {f.confirmed ? "" : " (pending confirmation)"}
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>Recovery options</summary>
        <ul style={{ display: "grid", gap: 4 }}>
          <li>
            Keep your recovery codes somewhere safe — they are issued during setup at sign-in.
          </li>
          <li>
            To replace a lost factor, enroll a new one above, then remove the old one in the
            provider&#39;s protected settings flow.
          </li>
          <li>
            Fully locked out? Contact support — recovery always verifies you through the provider,
            never by email alone.
          </li>
        </ul>
      </details>

      {error && (
        <p role="alert" style={{ color: "#f85149", margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
