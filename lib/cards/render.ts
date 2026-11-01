import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { artifactQueriesSchema, checkQueries, runArtifactQueries, type ArtifactQuery, type QueryShared } from "@/lib/ai/artifact-data";
import { cardParamsSchema, resolveParams, type CardParam, type ParamState } from "./params";
import { compileCard, runCard, type CardNode } from "./sandbox";
import { CardTreeError, sanitizeTree } from "./tree";
import { CARD_SIZE_KEYS, type CardSize } from "./sizes";

type Context = Awaited<ReturnType<typeof requireWorkspace>>;
export type CardVersion = { id: string; card_id: string; version: number; kind: "preset" | "code"; preset: string | null; compiled: string; queries: unknown; params: unknown };
export type CardRow = { id: string; artifact_id: string; title: string; size: string; published_version: number | null };
export type RenderedCard = { tree: CardNode | null; error: string | null; params: ParamState[] };
export const CARD_VERSION_COLUMNS = "id, card_id, version, kind, preset, compiled, queries, params";

/** Each card's CSS and ids are namespaced by this, so two cards never clash. */
export const cardScope = (cardId: string) => `c${cardId.replace(/-/g, "").slice(0, 12)}`;

// Same card version, size, params and data give the same tree, so a repeat view skips the sandbox. The data is
// part of the key, so a cached tree is never older than the data it was made from; scopes are checked before.
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

/** Runs the card's queries for today, then its code in the sandbox, then checks the tree. Errors become a message, never a broken Home. */
export async function renderCard(version: CardVersion, context: Context, { size, requested = {}, shared }: { size: CardSize; requested?: Record<string, string | undefined>; shared?: QueryShared }): Promise<RenderedCard> {
  const today = calendarDate(new Date(), context.settings.timezone);
  let params: ParamState[] = [];
  try {
    const { queries, params: declared } = definition(version);
    const { resolved, state } = resolveParams(declared, requested, today, context.workspace.locale);
    params = state;
    const data = await runArtifactQueries(queries, context, today, { params: resolved, shared });
    const input = { data, params: resolved.values, size };
    const key = createHash("sha256").update(JSON.stringify([RENDERER_VERSION, context.workspace.id, version.id, input])).digest("base64url");
    const hit = cache.get(key);
    if (hit) return { tree: hit, error: null, params };
    const tree = sanitizeTree(await runCard(version.compiled, input), { scope: cardScope(version.card_id) });
    remember(key, tree);
    return { tree, error: null, params };
  } catch (cause) {
    return { tree: null, error: `This card could not be shown: ${cause instanceof Error ? cause.message : "unknown error"}`, params };
  }
}

/**
 * Checks a new card before it is saved: it compiles, its queries are valid, and it renders a clean tree at
 * every size with today's data. The errors go back to the designer to fix.
 */
export async function checkCard(source: string, queries: ArtifactQuery[], params: CardParam[], context: Context) {
  let compiled: string;
  try { compiled = compileCard(source); } catch (cause) { return { errors: [`Syntax: ${cause instanceof Error ? cause.message : String(cause)}`] }; }
  const today = calendarDate(new Date(), context.settings.timezone);
  const { resolved } = resolveParams(params, {}, today, context.workspace.locale);
  const queryErrors = checkQueries(queries, today, resolved);
  if (queryErrors.length) return { errors: queryErrors };
  const data = await runArtifactQueries(queries, context, today, { params: resolved });
  const errors: string[] = [];
  for (const size of CARD_SIZE_KEYS) {
    try { sanitizeTree(await runCard(compiled, { data, params: resolved.values, size }), { scope: "check" }); }
    catch (cause) { errors.push(`${size}: ${cause instanceof CardTreeError ? "" : "runtime "}${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return errors.length ? { errors } : { compiled, errors };
}

/** The version a card shows: the one asked for (a draft preview), or the published one. */
export async function loadCardVersion(supabase: SupabaseClient, workspaceId: string, cardId: string, version?: number | null) {
  const query = supabase.from("artifact_card_versions").select(CARD_VERSION_COLUMNS).eq("workspace_id", workspaceId).eq("card_id", cardId);
  const { data, error } = await (version ? query.eq("version", version) : query.order("version", { ascending: false }).limit(1)).maybeSingle();
  if (error) throw error;
  return data as CardVersion | null;
}

