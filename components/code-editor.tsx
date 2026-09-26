"use client";

import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

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
      extensions={[javascript({ typescript: true })]}
      theme={oneDark}
      onChange={onChange}
    />
  );
}
