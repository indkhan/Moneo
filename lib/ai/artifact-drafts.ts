import { randomBytes } from "node:crypto";
import type { CardNode } from "@/lib/cards/sandbox";
import type { ParamState } from "@/lib/cards/params";
import type { CardSize } from "@/lib/cards/sizes";

type Owner = { workspaceId: string; artifactId: string };
export type PageDraft = Owner & { kind: "page"; html: string; data: Record<string, unknown> };
export type CardDraft = Owner & { kind: "card"; title: string; trees: Record<CardSize, CardNode>; params: ParamState[] };
type Draft = PageDraft | CardDraft;

const LIFETIME_MS = 5 * 60_000;
const holder = globalThis as { moneoArtifactDrafts?: Map<string, Draft & { expires: number }> };
const drafts = holder.moneoArtifactDrafts ??= new Map();

export function keepDraft(draft: Draft) {
  const now = Date.now();
  for (const [token, kept] of drafts) if (kept.expires <= now) drafts.delete(token);
  const token = randomBytes(18).toString("base64url");
  drafts.set(token, { ...draft, expires: now + LIFETIME_MS });
  return token;
}

export function findDraft<Kind extends Draft["kind"]>(kind: Kind, token: string, owner: Owner) {
  const draft = drafts.get(token);
  return draft && draft.kind === kind && draft.expires > Date.now() && draft.workspaceId === owner.workspaceId && draft.artifactId === owner.artifactId
    ? draft as Extract<Draft, { kind: Kind }> : null;
}

export const dropDraft = (token: string) => { drafts.delete(token); };
