"use client";

import { useState } from "react";
import {
  listSessions,
  readCsrfToken,
  revokeOtherSessions,
  revokeSession,
  type SessionListItem,
} from "@/lib/sessions-client";

/**
 * Issue 1.7 — Settings → Privacy & Security session controls (skeleton).
 * Current session, per-session revoke, and sign-out-others. Server state
 * lives in the session registry; this component only renders and relays.
 */
export function SessionSecurity({ initialSessions }: { initialSessions: SessionListItem[] }) {
  const [sessions, setSessions] = useState(initialSessions);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function refresh() {
    setSessions(await listSessions(globalThis.fetch, readCsrfToken(document.cookie)));
  }

  async function run(key: string, action: () => Promise<unknown>) {
    setError(null);
    setPending(key);
    try {
      await action();
      await refresh();
    } catch {
      setError("That did not work — please try again.");
    } finally {
      setPending(null);
    }
  }

  const others = sessions.filter((s) => !s.current);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <ul style={{ display: "grid", gap: 8, margin: 0, padding: 0, listStyle: "none" }}>
        {sessions.map((session) => (
          <li
            key={session.id}
            style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
          >
            <span style={{ fontWeight: session.current ? 700 : 400 }}>
              {session.current ? "This device" : (session.userAgent ?? "Unknown device")}
            </span>
            <span style={{ opacity: 0.75, fontSize: 13 }}>
              {session.current && session.userAgent ? `${session.userAgent} · ` : ""}
              since {session.createdAt ? new Date(session.createdAt).toLocaleString() : "—"}
            </span>
            {!session.current && (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() =>
                  void run(`revoke:${session.id}`, () =>
                    revokeSession(globalThis.fetch, readCsrfToken(document.cookie), session.id),
                  )
                }
              >
                {pending === `revoke:${session.id}` ? "Revoking…" : "Revoke"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <div>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() =>
              void run("others", () =>
                revokeOtherSessions(globalThis.fetch, readCsrfToken(document.cookie)),
              )
            }
          >
            {pending === "others" ? "Signing out…" : "Sign out other sessions"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: "#f85149" }}>
          {error}
        </p>
      )}
    </div>
  );
}
