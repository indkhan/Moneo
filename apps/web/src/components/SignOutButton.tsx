"use client";

import { useState } from "react";
import { readCsrfToken, signOut } from "@/lib/sessions-client";

/** Issue 1.7 — topbar sign-out: POSTs (CSRF-guarded) then leaves the IdP session too. */
export function SignOutButton() {
  const [pending, setPending] = useState(false);

  async function onClick() {
    if (pending) {
      return;
    }
    setPending(true);
    try {
      const { federatedLogoutUrl } = await signOut(
        globalThis.fetch,
        readCsrfToken(document.cookie),
      );
      window.location.assign(federatedLogoutUrl);
    } catch {
      setPending(false);
    }
  }

  return (
    <button type="button" onClick={() => void onClick()} disabled={pending}>
      {pending ? "Signing out…" : "Log out"}
    </button>
  );
}
