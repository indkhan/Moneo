import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { CurrencySelect } from "./currency-select";

// A mounted picker keeps its hook state across renders; this replays that without a DOM.
const hooks = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, dirty: false }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useId: () => "id", useEffect: () => {},
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (index === hooks.state.length) hooks.state.push(typeof initial === "function" ? initial() : initial);
    return [hooks.state[index], (next: unknown) => { hooks.state[index] = next; hooks.dirty = true; }];
  },
}));

function submitted(node: ReactNode): unknown {
  if (!isValidElement<{ children?: ReactNode; name?: string; value?: unknown }>(node)) return undefined;
  if (node.type === "input" && node.props.name === "currency") return node.props.value;
  for (const child of Children.toArray(node.props.children)) { const value = submitted(child); if (value !== undefined) return value; }
  return undefined;
}
function render(defaultValue: string) {
  let tree: ReactNode;
  do { hooks.dirty = false; hooks.cursor = 0; tree = CurrencySelect({ name: "currency", label: "Currency", defaultValue, locale: "en" }); } while (hooks.dirty);
  return submitted(tree);
}

beforeEach(() => { hooks.state.length = 0; });

it("submits the new saved currency when it changes while mounted", () => {
  expect(render("EUR")).toBe("EUR");
  expect(render("USD")).toBe("USD");
});

it("keeps what the person typed while the saved currency stays the same", () => {
  render("EUR");
  hooks.state[1] = "JPY · Japanese Yen";
  expect(render("EUR")).toBe("JPY");
});
