import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReadonlyWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { artifactQueriesSchema, checkQueries, runArtifactQueries, type ArtifactQuery, type QueryShared } from "@/lib/ai/artifact-data";
import { cardParamsSchema, resolveParams, type CardParam, type ParamState } from "./params";
import { compileCard, runCard, type CardNode } from "./sandbox";
import { CardTreeError, sanitizeTree } from "./tree";
import { CARD_SIZE_KEYS, type CardSize } from "./sizes";
import { localValues, type LocalRun } from "./local";
import { rowCoverage } from "./coverage";

type Context = ReadonlyWorkspace;
export type CardVersion = { id: string; card_id: string; version: number; title: string; kind: "preset" | "code"; preset: string | null; compiled: string; queries: unknown; params: unknown };
export type CardRow = { id: string; artifact_id: string; title: string; size: string; published_version: number | null };
export type RenderedCard = { tree: CardNode | null; error: string | null; params: ParamState[]; local?: LocalRun | null };
export const CARD_VERSION_COLUMNS = "id, card_id, version, title, kind, preset, compiled, queries, params";

export const cardScope = (cardId: string) => `c${cardId.replace(/-/g, "").slice(0, 12)}`;

const cache = new Map<string, CardNode>();
const CACHE_ENTRIES = 500;
const RENDERER_VERSION = 1;
function remember(key: string, tree: CardNode) {
  cache.delete(key);
  cache.set(key, tree);
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

function definition(version: Pick<CardVersion, "queries" | "params">) {
  return { queries: artifactQueriesSchema.parse(version.queries), params: cardParamsSchema.parse(version.params) };
}

export async function renderCard(version: CardVersion, context: Context, { size, requested = {}, shared }: { size: CardSize; requested?: Record<string, string | undefined>; shared?: QueryShared }): Promise<RenderedCard> {
  const today = calendarDate(new Date(), context.settings.timezone);
  let params: ParamState[] = [];
  try {
    const { queries, params: declared } = definition(version);
    const { resolved, state } = resolveParams(declared, requested, today, context.workspace.locale);
    params = state;
    const data = await runArtifactQueries(queries, context, today, { params: resolved, shared });
    const input = { data, params: { ...resolved.values, ...localValues(state) }, size };
    const local = state.some(param => param.control) ? { compiled: version.compiled, data, values: resolved.values } : null;
    const key = createHash("sha256").update(JSON.stringify([RENDERER_VERSION, context.workspace.id, version.id, input])).digest("base64url");
    const hit = cache.get(key);
    if (hit) return { tree: hit, error: null, params, local };
    const tree = sanitizeTree(await runCard(version.compiled, input), { scope: cardScope(version.card_id) });
    remember(key, tree);
    return { tree, error: null, params, local };
  } catch (cause) {
    return { tree: null, error: `This card could not be shown: ${cause instanceof Error ? cause.message : "unknown error"}`, params };
  }
}

function controls(node: CardNode, found = new Set<string>()): Set<string> {
  if (typeof node === "string") return found;
  if (node.type === "kit:Param") found.add(String(node.props.name));
  if (node.type === "kit:Tabs") for (const tab of node.props.tabs as { content: CardNode }[]) controls(tab.content, found);
  for (const child of node.children) controls(child, found);
  return found;
}

export const CHECK_SCOPE = "check";

export async function checkCard(source: string, queries: ArtifactQuery[], params: CardParam[], context: Context) {
  let compiled: string;
  try { compiled = compileCard(source); } catch (cause) { return { errors: [`Syntax: ${cause instanceof Error ? cause.message : String(cause)}`] }; }
  const today = calendarDate(new Date(), context.settings.timezone);
  const { resolved, state } = resolveParams(params, {}, today, context.workspace.locale);
  const queryErrors = checkQueries(queries, today, resolved);
  if (queryErrors.length) return { errors: queryErrors };
  const data = await runArtifactQueries(queries, context, today, { params: resolved });
  const errors: string[] = [];
  const trees: Partial<Record<CardSize, CardNode>> = {};
  const values = { ...resolved.values, ...localValues(state) };
  for (const end of ["min", "max"] as const) {
    const moved = Object.fromEntries(params.flatMap((param): [string, number | boolean][] => param.kind === "number" ? [[param.name, param[end]]] : param.kind === "toggle" ? [[param.name, !param.default]] : []));
    if (!Object.keys(moved).length) break;
    try { sanitizeTree(await runCard(compiled, { data, params: { ...values, ...moved }, size: "M" }), { scope: CHECK_SCOPE }); }
    catch (cause) { errors.push(`With sliders at their ${end} and switches flipped (${JSON.stringify(moved)}): ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  for (const size of CARD_SIZE_KEYS) {
    try {
      const tree = sanitizeTree(await runCard(compiled, { data, params: values, size }), { scope: CHECK_SCOPE });
      trees[size] = tree;
      const shown = controls(tree);
      const missing = params.filter(param => !shown.has(param.name)).map(param => param.name);
      if (missing.length) errors.push(`${size}: declared params without a <Kit.Param name="…" /> control: ${missing.join(", ")}`);
    }
    catch (cause) { errors.push(`${size}: ${cause instanceof CardTreeError ? "" : "runtime "}${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return errors.length ? { errors } : { compiled, errors, data, trees: trees as Record<CardSize, CardNode>, state, hidden: rowCoverage(data, trees) };
}

export async function loadCardVersion(supabase: SupabaseClient, workspaceId: string, cardId: string, version?: number | null) {
  const query = supabase.from("artifact_card_versions").select(CARD_VERSION_COLUMNS).eq("workspace_id", workspaceId).eq("card_id", cardId);
  const { data, error } = await (version ? query.eq("version", version) : query.order("version", { ascending: false }).limit(1)).maybeSingle();
  if (error) throw error;
  return data as CardVersion | null;
}

