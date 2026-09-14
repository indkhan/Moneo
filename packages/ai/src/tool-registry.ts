export interface AiTool<Output = unknown> {
  name: string;
  readOnly?: true;
  scopes: string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  limits?: { maxResultBytes?: number };
  retryClass?: "never" | "safe";
  execute: (
    context: { workspaceId: string },
    input: Record<string, unknown>,
  ) => Promise<Output> | Output;
}
export function createToolRegistry(tools: AiTool[]) {
  const byName = new Map(
    tools.map((tool) => [
      tool.name,
      { ...tool, readOnly: true as const, retryClass: tool.retryClass ?? ("never" as const) },
    ]),
  );
  return {
    definitions: [...byName.values()].map(({ execute: _execute, ...metadata }) => metadata),
    async execute(
      name: string,
      input: Record<string, unknown>,
      context: { workspaceId: string; scopes: string[] },
    ) {
      if ("workspaceId" in input) throw new Error("Model input must not supply workspaceId");
      const tool = byName.get(name);
      if (!tool) throw new Error("Unknown tool");
      if (!tool.scopes.every((scope) => context.scopes.includes(scope)))
        throw new Error("Tool scope denied");
      const result = await tool.execute({ workspaceId: context.workspaceId }, input);
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > (tool.limits?.maxResultBytes ?? 100_000))
        throw new Error("Tool result exceeds limit");
      return result;
    },
  };
}
