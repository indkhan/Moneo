import { AI_AGENTS, type AiAgent } from "@/lib/workspace-settings-options";

export type ModelConnections = { openai: boolean; claude: boolean; openrouter: boolean };

export function modelIsConnected(id: string, connections: ModelConnections) {
  return id.includes("/") ? connections.openrouter : id.startsWith("claude-") ? connections.claude : connections.openai;
}

export function modelOptions(connections: ModelConnections) {
  return [
    ...(connections.openai ? ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-luna"] : []),
    ...(connections.claude ? ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] : []),
    ...(connections.openrouter ? ["openai/gpt-6.1-sol", "anthropic/claude-opus-5.5", "nvidia/nemotron-3.5-lightning:free"] : []),
  ];
}

export function connectedDefault(agent: AiAgent, connections: ModelConnections, preferClaude: boolean) {
  if (connections.claude && (preferClaude || !connections.openai && !connections.openrouter)) return AI_AGENTS[agent].claude;
  if (!connections.openai && connections.openrouter) return `openai/${AI_AGENTS[agent].model}`;
  return AI_AGENTS[agent].model;
}
