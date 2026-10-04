"use client";

import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

const extensions = [javascript({ typescript: true })];

export function CodeEditor({
  value,
  onChange,
}: {
  value: string;
  onChange?: (v: string) => void;
}) {
  return (
    <CodeMirror
      value={value}
      height="280px"
      extensions={extensions}
      theme={oneDark}
      onChange={onChange}
      indentWithTab={false}
      onCreateEditor={view => view.contentDOM.setAttribute("aria-label", "Calculator source")}
    />
  );
}
