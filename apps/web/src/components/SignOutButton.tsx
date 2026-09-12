"use client";

import { readCsrfToken, revokeAllSessions } from "@/lib/sessions-client";

/** Revoke Moneo sessions, then let the official SDK end the Auth0 session. */
export function SignOutButton() {
  async function onClick() {
    try {
      await revokeAllSessions(globalThis.fetch, readCsrfToken(document.cookie));
    } finally {
      window.location.assign("/auth/logout");
    }
  }

  return <button type="button" onClick={() => void onClick()}>Log out</button>;
}
