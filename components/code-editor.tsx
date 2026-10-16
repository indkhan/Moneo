"use client";

import { useSyncExternalStore } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

const extensions = [javascript({ typescript: true })];

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

export function CodeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange?: (v: string) => void;
}) {
  // Follow the app theme instead of forcing a dark editor into the light UI.
  const dark = useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme === "dark", () => false);
  return (
    <CodeMirror
      value={value}
      height="360px"
      extensions={extensions}
      theme={dark ? oneDark : "light"}
      onChange={onChange}
      indentWithTab={false}
      onCreateEditor={view => view.contentDOM.setAttribute("aria-label", "Calculator source")}
    />
  );
}
