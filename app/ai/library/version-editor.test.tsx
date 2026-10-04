import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionEditor } from "./version-editor";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

it("reserves editor space with accessible loading feedback before loading CodeMirror", () => {
  const html = renderToStaticMarkup(<VersionEditor artifactId="test" activeVersionId={null} versions={[]} currentSource="input => ({})" currentManifest={{}} />);
  expect(html).toContain("Loading source editor");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("cm-theme");
  expect(html).toContain("Save new version");
});
