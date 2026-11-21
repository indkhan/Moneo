"use client";

import { useEffect } from "react";
import { isDraftCardPreview } from "@/lib/draft-preview";

function previewTheme() {
  if (!isDraftCardPreview(location.pathname)) return null;
  const theme = new URLSearchParams(location.search).get("theme");
  return theme === "light" || theme === "dark" ? theme : null;
}

export function ThemePreference({ preference }: { preference: "light" | "dark" | "system" }) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const forced = previewTheme();
    const apply = () => { document.documentElement.dataset.theme = forced ?? (preference === "system" ? media.matches ? "dark" : "light" : preference); };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);
  return null;
}
