"use client";

import { useEffect } from "react";

/** Registers the service worker that makes Moneo installable on phones and tablets. It caches nothing but the offline page. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* installing the app is optional */ });
  }, []);
  return null;
}
