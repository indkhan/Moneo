import type { ParamState } from "./params";
import type { CardNode } from "./engine";

export type LocalRun = { compiled: string; data: Record<string, unknown>; values: Record<string, string> };

export function localValues(state: ParamState[]): Record<string, number | boolean> {
  return Object.fromEntries(state.flatMap((param): [string, number | boolean][] => param.control?.kind === "number" ? [[param.name, Number(param.value)]]
    : param.control?.kind === "toggle" ? [[param.name, param.value === "true"]] : []));
}

export async function rerunCard(local: LocalRun, state: ParamState[], size: string, scope: string): Promise<CardNode> {
  const [{ runCard }, { sanitizeTree }] = await Promise.all([import("./engine"), import("./tree")]);
  return sanitizeTree(await runCard(local.compiled, { data: local.data, params: { ...local.values, ...localValues(state) }, size }), { scope });
}
