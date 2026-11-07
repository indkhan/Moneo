import type { ParamState } from "./params";
import type { CardNode } from "./engine";

/** What a card with sliders or switches sends to the browser so it can rerun there: its code, its data and its other params. */
export type LocalRun = { compiled: string; data: Record<string, unknown>; values: Record<string, string> };

/** The values the card's code gets for its sliders and switches. */
export function localValues(state: ParamState[]): Record<string, number | boolean> {
  return Object.fromEntries(state.flatMap((param): [string, number | boolean][] => param.control?.kind === "number" ? [[param.name, Number(param.value)]]
    : param.control?.kind === "toggle" ? [[param.name, param.value === "true"]] : []));
}

/**
 * Reruns the card in the browser as a slider moves: the same QuickJS sandbox and tree check as on the server,
 * with the data it already has, so nothing is fetched. Loaded only when a card has such a control.
 */
export async function rerunCard(local: LocalRun, state: ParamState[], size: string, scope: string): Promise<CardNode> {
  const [{ runCard }, { sanitizeTree }] = await Promise.all([import("./engine"), import("./tree")]);
  return sanitizeTree(await runCard(local.compiled, { data: local.data, params: { ...local.values, ...localValues(state) }, size }), { scope });
}
