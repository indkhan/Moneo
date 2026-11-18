"use client";

import { useEffect } from "react";

const pageWorksWithoutOfflineSupport = () => undefined;

export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(pageWorksWithoutOfflineSupport);
  }, []);
  return null;
}
