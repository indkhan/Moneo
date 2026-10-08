import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionEditor } from "./version-editor";

const host = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], editor: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = initial;
    return [host.slots[index], (next: unknown) => { host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next; }];
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = host.index++, previous = host.slots[index] as { deps: unknown[]; callback: unknown } | undefined;
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) host.slots[index] = { deps, callback };
    return (host.slots[index] as { callback: unknown }).callback;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => (props: unknown) => { host.editor(props); return null; } }));
afterEach(() => { host.index = 0; host.slots = []; vi.clearAllMocks(); });

it("keeps the source callback stable during typing without rebuilding CodeMirror configuration", () => {
  const props = { artifactId: "test", activeVersionId: "v1", versions: [], currentSource: "input => ({})", currentManifest: {} };
  function render() {
    host.index = 0;
    renderToStaticMarkup(<VersionEditor {...props} />);
    return host.editor.mock.lastCall![0] as { value: string; onChange: (source: string) => void };
  }
  const before = render();
  before.onChange("input => ({ summary: 'Typed' })");
  const after = render();
  expect(after.value).toBe("input => ({ summary: 'Typed' })");
  expect(after.onChange).toBe(before.onChange);
});
