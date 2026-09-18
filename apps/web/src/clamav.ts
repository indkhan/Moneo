// E02-S03 minimal clamd client on node:net (no new dependencies): INSTREAM
// scan of in-memory bytes with a bounded deadline. The scanner receives raw
// quarantine bytes only — never DB/model credentials, never anything else.
// Verdicts: "CLEAN" | { infected: signature }. Transport errors are
// transient (caller decides retry); an INFECTED verdict is permanent input.

import { connect, type Socket } from "node:net";

export type ClamConfig = { host: string; port: number };

export type ScanVerdict = { clean: true } | { clean: false; signature: string };

const CHUNK = 64 * 1024;

function sanitizedSignature(raw: string): string {
  // Scanner signature names are vendor-controlled text; keep a tight
  // allowlist so they cannot smuggle control bytes into stored metadata.
  const trimmed = raw.trim().slice(0, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-()]{0,119}$/.test(trimmed)) return "unprintable-signature";
  return trimmed;
}

export async function clamdPing(config: ClamConfig, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    const socket: Socket = connect({ host: config.host, port: config.port }, () => {
      socket.write("PING", () => undefined);
    });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("data", (data) => finish(String(data).includes("PONG")));
    socket.on("error", () => finish(false));
    socket.on("timeout", () => finish(false));
  });
}

/** Stream bytes to clamd INSTREAM; resolves CLEAN or the found signature. */
export async function clamdScan(config: ClamConfig, bytes: Uint8Array, timeoutMs = 60_000): Promise<ScanVerdict> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (verdict: ScanVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch { /* already gone */ }
      resolve(verdict);
    };
    const finishReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already gone */ }
      reject(err);
    };
    const socket: Socket = connect({ host: config.host, port: config.port }, () => {
      socket.write("zINSTREAM\0", (err) => {
        if (err) {
          finishReject(new Error(`clamd write failed: ${(err as Error).message}`));
          return;
        }
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
          const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.byteLength));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(slice.byteLength, 0);
          socket.write(header);
          socket.write(Buffer.from(slice));
        }
        const done = Buffer.alloc(4);
        socket.write(done);
      });
    });
    const timer = setTimeout(() => finishReject(new Error("clamd scan deadline exceeded")), timeoutMs);
    let reply = "";
    socket.setTimeout(timeoutMs, () => finishReject(new Error("clamd scan deadline exceeded")));
    socket.on("data", (data) => {
      reply += data.toString("utf8");
      // INSTREAM replies are NUL-terminated (the `z` command prefix asks
      // for it); never wait for a newline that will not come.
      if (!reply.includes("\n") && !reply.includes("\0")) return;
      if (reply.includes("OK") && !reply.includes("FOUND")) finishResolve({ clean: true });
      else {
        const found = reply.match(/stream:\s*(.+?)\s+FOUND/);
        finishResolve({ clean: false, signature: sanitizedSignature(found?.[1] ?? "unknown") });
      }
    });
    socket.on("error", (err) => finishReject(new Error(`clamd connection failed: ${(err as Error).message}`)));
    socket.on("timeout", () => finishReject(new Error("clamd scan deadline exceeded")));
    socket.on("close", () => {
      if (!settled) finishReject(new Error("clamd closed the connection mid-scan"));
    });
  });
}
