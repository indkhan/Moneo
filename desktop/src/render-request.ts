export type RenderRequest = { path: string; width: number; height: number; full: boolean; script: string };
export type Rendered = { png: string; result: unknown };

const DRAFT_PATH = /^\/ai\/artifacts\/[0-9a-f-]{36}\/draft(-card)?\?[\w=&%.-]{1,300}$/;

export function renderRequest(body: unknown): RenderRequest | null {
  if (!body || typeof body !== "object") return null;
  const { path, width, height, full, script } = body as Record<string, unknown>;
  const size = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 240 && value <= 2000;
  if (typeof path !== "string" || !DRAFT_PATH.test(path) || !size(width) || !size(height) || typeof full !== "boolean" || typeof script !== "string" || script.length > 20000) return null;
  return { path, width: width as number, height: height as number, full, script };
}
