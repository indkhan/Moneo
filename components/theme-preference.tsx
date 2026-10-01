"use client";

import { useEffect } from "react";

export function ThemePreference({ preference }: { preference: "light" | "dark" | "system" }) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = preference === "system" ? media.matches ? "dark" : "light" : preference; };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);
  return null;
}
