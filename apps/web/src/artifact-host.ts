import { ARTIFACT_LIMITS, ARTIFACT_PROTOCOL, type ArtifactSource, type ArtifactManifest, RENDERER_ORIGIN } from "./artifact-contract.ts";

export interface ArtifactSession {
    sessionId: string;
    workspaceId: string;
    userId: string;
    artifactId: string;
    artifactVersionId: string;
    approvedPermissions: string[];
    openedAt: Date;
    expiresAt: Date;
    nonce: string;
    port?: MessagePort;
    worker?: Worker;
    state: Record<string, unknown>;
    source: ArtifactSource;
    manifest: ArtifactManifest;
    status: "loading" | "connected" | "ready" | "terminated" | "stopped" | "rejected";
    iframe?: HTMLIFrameElement;
}

const sessions = new Map<string, ArtifactSession>();
const byteSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function generateNonce(): string {
    return crypto.randomUUID();
}

function createIframe(): HTMLIFrameElement {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts allow-same-origin";
    iframe.style.border = "none";
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    return iframe;
}

function getRendererUrl(nonce: string): string {
    return RENDERER_ORIGIN + "/artifact-renderer.html?session=" + encodeURIComponent(nonce) + "#" + nonce;
}

async function handleRpcRequest(session: ArtifactSession, method: string, args: unknown, requestId: string): Promise<void> {
    const permissionMap: Record<string, string> = {
        "spendingByCategory": "analytics.spending_by_category",
        "cashflow": "analytics.cashflow",
        "getBalances": "balances.read",
        "transactionSummary": "transactions.summary.read",
    };
    const requiredPermission = permissionMap[method];
    if (requiredPermission && !session.approvedPermissions.includes(requiredPermission)) {
        const sessionPort = sessions.get(session.sessionId)?.port;
        if (sessionPort) {
            sessionPort.postMessage({ type: "rpc_response", value: { requestId, error: "permission_denied" }, protocol: ARTIFACT_PROTOCOL, nonce: session.nonce });
        }
        return;
    }

    try {
        const response = await fetch("/api/artifacts/sdk/rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
                sessionId: session.sessionId,
                method,
                args,
            }),
        });
        const result = await response.json();
        if (!response.ok) {
            const sessionPort = sessions.get(session.sessionId)?.port;
            if (sessionPort) {
                sessionPort.postMessage({ type: "rpc_response", value: { requestId, error: result.error || "rpc_failed" }, protocol: ARTIFACT_PROTOCOL, nonce: session.nonce });
            }
        } else {
            const sessionPort = sessions.get(session.sessionId)?.port;
            if (sessionPort) {
                sessionPort.postMessage({ type: "rpc_response", value: { requestId, result }, protocol: ARTIFACT_PROTOCOL, nonce: session.nonce });
            }
        }
    } catch (error) {
        const sessionPort = sessions.get(session.sessionId)?.port;
        if (sessionPort) {
            sessionPort.postMessage({ type: "rpc_response", value: { requestId, error: error instanceof Error ? error.message : "network_error" }, protocol: ARTIFACT_PROTOCOL, nonce: session.nonce });
        }
    }
}

export type SessionRecordInput = {
    sessionId: string;
    workspaceId: string;
    userId: string;
    artifactId: string;
    artifactVersionId: string;
    approvedPermissions: string[];
    source: ArtifactSource;
    manifest: ArtifactManifest;
    initialState: Record<string, unknown>;
};

/** Server-safe session record: no DOM. The browser attaches the iframe. */
export function createSessionRecord(input: SessionRecordInput): ArtifactSession {
    const existing = sessions.get(input.sessionId);
    if (existing) {
        existing.iframe?.remove();
        existing.port?.close();
        existing.worker?.terminate();
    }
    const sourceSize = byteSize(input.source.html) + byteSize(input.source.css) + byteSize(input.source.js);
    if (sourceSize > ARTIFACT_LIMITS.sourceBytes) throw new Error("source_limit");
    const session: ArtifactSession = {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        artifactId: input.artifactId,
        artifactVersionId: input.artifactVersionId,
        approvedPermissions: input.approvedPermissions,
        openedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        nonce: generateNonce(),
        state: { ...input.initialState },
        source: { ...input.source },
        manifest: { ...input.manifest },
        status: "loading",
    };
    sessions.set(input.sessionId, session);
    return session;
}

export function openArtifactSession(
    sessionId: string,
    workspaceId: string,
    userId: string,
    artifactId: string,
    artifactVersionId: string,
    approvedPermissions: string[],
    source: ArtifactSource,
    manifest: ArtifactManifest,
    initialState: Record<string, unknown>,
    container: HTMLElement
): ArtifactSession {
    const session = createSessionRecord({ sessionId, workspaceId, userId, artifactId, artifactVersionId, approvedPermissions, source, manifest, initialState });
    const nonce = session.nonce;

    const iframe = createIframe();
    container.appendChild(iframe);
    session.iframe = iframe;

    iframe.src = getRendererUrl(nonce);
    session.status = "loading";

    const channel = new MessageChannel();
    session.port = channel.port1;

    channel.port1.onmessage = async ({ data }) => {
        const current = sessions.get(sessionId);
        if (!current || data.nonce !== current.nonce || data.protocol !== 1 || byteSize(data) > ARTIFACT_LIMITS.messageBytes) return;

        if (data.type === "state" && data.value && typeof data.value === "object") {
            current.state = { ...current.state, ...data.value };
        }
        if (data.type === "status") {
            current.status = data.value;
            if (data.value === "ready") {
                current.status = "ready";
            } else if (data.value === "terminated" || data.value === "stopped" || data.value === "rejected") {
                current.status = data.value;
                setTimeout(() => cleanupSession(sessionId), 100);
            }
        }
        if (data.type === "rpc_request") {
            const { method, args, requestId } = data.value as { method: string; args: unknown; requestId: string };
            await handleRpcRequest(current, method, args, requestId);
        }
    };

    const startMsg = {
        type: "start",
        protocol: 1,
        nonce,
        source,
        state: initialState,
        finance: { categories: [], cashflow: [], balances: [], transactionSummary: [] },
        manifest,
    };

    iframe.onload = () => {
        try {
            iframe.contentWindow?.postMessage({ type: "connect", protocol: 1, nonce }, RENDERER_ORIGIN, [channel.port2]);
            session.status = "connected";
            channel.port1.postMessage(startMsg);
        } catch {
            session.status = "rejected";
        }
    };

    return session;
}

export function sendArtifactEvent(sessionId: string, action: string, value: string): boolean {
    const session = sessions.get(sessionId);
    if (!session || session.status !== "ready" || !session.port) return false;
    try {
        session.port.postMessage({ type: "event", value: { action, value }, protocol: 1, nonce: session.nonce });
        return true;
    } catch {
        return false;
    }
}

export function stopArtifactSession(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session || !session.port) return false;
    try {
        session.port.postMessage({ type: "stop", protocol: 1, nonce: session.nonce });
        return true;
    } catch {
        return false;
    }
}

export function restartArtifactSession(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;
    try {
        session.port?.postMessage({ type: "stop", protocol: 1, nonce: session.nonce });
    } catch { }
    const container = session.iframe?.parentElement;
    if (!container) return false;
    openArtifactSession(
        sessionId,
        session.workspaceId,
        session.userId,
        session.artifactId,
        session.artifactVersionId,
        session.approvedPermissions,
        session.source,
        session.manifest,
        session.state,
        container
    );
    return true;
}

export function closeArtifactSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.port?.close();
    session.worker?.terminate();
    session.iframe?.remove();
    sessions.delete(sessionId);
}

export function getArtifactSession(sessionId: string): ArtifactSession | undefined {
    return sessions.get(sessionId);
}

function cleanupSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.port?.close();
    session.worker?.terminate();
    session.iframe?.remove();
    sessions.delete(sessionId);
}

export function getActiveSessionsCount(userId: string): number {
    let count = 0;
    for (const session of sessions.values()) {
        if (session.userId === userId && session.status === "ready") count++;
    }
    return count;
}

export function getArtifactExecutionsCount(artifactId: string): number {
    let count = 0;
    for (const session of sessions.values()) {
        if (session.artifactId === artifactId && session.status === "ready") count++;
    }
    return count;
}