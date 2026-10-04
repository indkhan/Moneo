import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeEditor } from "./code-editor";

const { setAttribute, editorProps } = vi.hoisted(() => ({ setAttribute: vi.fn(), editorProps: vi.fn() }));
vi.mock("@uiw/react-codemirror", () => ({ default: (props: { indentWithTab?: boolean; onCreateEditor?: (view: unknown) => void }) => {
  editorProps(props);
  props.onCreateEditor?.({ contentDOM: { setAttribute } });
  return null;
} }));

it("names the editable source and allows Tab to move to the next form control", () => {
  renderToStaticMarkup(<CodeEditor value="input => ({ summary: 'Test' })" />);
  expect(setAttribute).toHaveBeenCalledWith("aria-label", "Calculator source");
  expect(editorProps.mock.lastCall?.[0].indentWithTab).toBe(false);
});

it("reuses language extensions when the source value changes", () => {
  const onChange = vi.fn();
  renderToStaticMarkup(<CodeEditor value="input => ({})" onChange={onChange} />);
  const before = editorProps.mock.lastCall?.[0].extensions;
  renderToStaticMarkup(<CodeEditor value="input => ({ summary: 'Updated' })" onChange={onChange} />);
  expect(editorProps.mock.lastCall?.[0].extensions).toBe(before);
});
