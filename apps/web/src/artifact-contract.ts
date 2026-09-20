export const ARTIFACT_LIMITS = {
    sourceBytes: 2 * 1024 * 1024,
    heapBytes: 16 * 1024 * 1024,
    stackBytes: 512 * 1024,
    messageBytes: 1024 * 1024,
    messagesPerSecond: 100,
    executionMs: 5000,
    maxOpenSessionsPerUser: 4,
    maxConcurrentExecutionsPerArtifact: 2,
    maxSdkCallsPerSession: 8,
    maxSdkCallsPerMinute: 60,
    maxResultRows: 500,
    maxResultBytes: 1024 * 1024,
    maxStateBytes: 64 * 1024,
    maxStateKeys: 100,
    maxStateDepth: 8,
} as const;

export const ARTIFACT_PROTOCOL = 1;

export const RENDERER_ORIGIN = "http://127.0.0.1:4174";

export type ArtifactSource = {
    html: string;
    css: string;
    js: string;
};

export type ArtifactManifest = {
    artifactSdkVersion: string;
    runtimeVersion: string;
    sourceSchemaVersion: string;
    stateSchemaVersion: string;
    requestedPermissions: string[];
    approvedPermissions: string[];
    entrypoints: { full: string; compact: string };
    resourceBudget: Record<string, number>;
    sourceHash: string;
    buildHash: string;
    createdByAIRun?: string;
    createdByUser?: string;
    createdAt: string;
};

export type StartMessage = {
    type: "start";
    protocol: number;
    nonce: string;
    source: ArtifactSource;
    state: Record<string, unknown>;
    finance: Record<string, unknown>;
    manifest: ArtifactManifest;
};

export type RuntimeMessage =
    | { type: "render"; value: unknown; protocol: number; nonce: string }
    | { type: "patch"; value: unknown; protocol: number; nonce: string }
    | { type: "state"; value: Record<string, unknown>; protocol: number; nonce: string }
    | { type: "status"; value: string; protocol: number; nonce: string }
    | { type: "stop"; protocol: number; nonce: string }
    | { type: "rpc_request"; value: { method: string; args: unknown; requestId: string }; protocol: number; nonce: string }
    | { type: "rpc_response"; value: { requestId: string; result?: unknown; error?: string }; protocol: number; nonce: string };

export type HostMessage =
    | { type: "start"; protocol: number; nonce: string; source: ArtifactSource; state: Record<string, unknown>; finance: Record<string, unknown>; manifest: ArtifactManifest }
    | { type: "event"; value: unknown; protocol: number; nonce: string }
    | { type: "stop"; protocol: number; nonce: string }
    | { type: "rpc_response"; value: { requestId: string; result?: unknown; error?: string }; protocol: number; nonce: string };

export type AllowedPermissions =
    | "balances.read"
    | "analytics.cashflow"
    | "analytics.spending_by_category"
    | "transactions.summary.read";

export const RUNTIME_PERMISSIONS: AllowedPermissions[] = [
    "balances.read",
    "analytics.cashflow",
    "analytics.spending_by_category",
    "transactions.summary.read",
];