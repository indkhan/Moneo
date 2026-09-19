import { ARTIFACT_LIMITS, ARTIFACT_PROTOCOL, type ArtifactSource, type ArtifactManifest, type RuntimeMessage, RENDERER_ORIGIN } from "./artifact-contract.ts";

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
    iframe: HTMLIFrameElement;
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
    return `${RENDERER_ORIGIN}/artifact-renderer.html?session=${encodeURIComponent(nonce)}#${nonce}`;
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
    const existing = sessions.get(sessionId);
    if (existing) {
        existing.iframe.remove();
        existing.port?.close();
        existing.worker?.terminate();
    }

    const nonce = generateNonce();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min session

    const iframe = createIframe();
    container.appendChild(iframe);

    const session: ArtifactSession = {
        sessionId,
        workspaceId,
        userId,
        artifactId,
        artifactVersionId,
        approvedPermissions,
        openedAt: new Date(),
        expiresAt,
        nonce,
        state: { ...initialState },
        source: { ...source },
        manifest: { ...manifest },
        status: "loading",
        iframe,
    };

    sessions.set(sessionId, session);

    const sourceSize = byteSize(source.html) + byteSize(source.css) + byteSize(source.js);
    if (sourceSize > ARTIFACT_LIMITS.sourceBytes) {
        session.status = "rejected";
        iframe.remove();
        throw new Error("source_limit");
    }

    iframe.src = getRendererUrl(nonce);
    session.status = "loading";

    const channel = new MessageChannel();
    session.port = channel.port1;

    channel.port1.onmessage = ({ data }) => {
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
    // Reopen with same source/state
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
        session.iframe.parentElement!
    );
    return true;
}

export function closeArtifactSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.port?.close();
    session.worker?.terminate();
    session.iframe.remove();
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
    session.iframe.remove();
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