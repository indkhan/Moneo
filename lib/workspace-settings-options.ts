export const AI_DATA_SCOPES = ["accounts", "transactions", "planning", "imports"] as const;
export type AiDataScope = typeof AI_DATA_SCOPES[number];
export const AI_AGENTS = {
  chat: { label: "Chat assistant", model: "gpt-6-luna", claude: "claude-opus-5-5" },
  review: { label: "Financial review", model: "gpt-6-luna", claude: "claude-opus-5-5" },
  agents: { label: "Agent team", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  imports: { label: "Import mapping", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  organize: { label: "Organization suggestions", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  artifacts: { label: "Artifact builder", model: "gpt-6-luna", claude: "claude-opus-5-5" },
  titles: { label: "Chat titles", model: "gpt-6-luna", claude: "claude-haiku-5-5" },
  voice_call: { label: "Voice call", model: "gpt-6-luna", claude: "claude-opus-5-5" },
} as const;
export type AiAgent = keyof typeof AI_AGENTS;
export const AI_AGENT_KEYS = Object.keys(AI_AGENTS) as AiAgent[];
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
export const DEFAULT_VOICE = VOICES[0];
export const SPEECH_ENGINES = ["openai", "local", "openrouter"] as const;
export type SpeechEngineId = typeof SPEECH_ENGINES[number];

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
