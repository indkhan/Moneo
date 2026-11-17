import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { UpdateStatus } from "./updates";

const RETURN_PATH = /^\/(import\?(bank|scalable)=(connected|error|invalid)(#scalable)?|settings\?chatgpt=[A-Za-z0-9%._~-]{1,600}#ai-access)$/;

export type BridgeHandlers = {
  onReturn(path: string): Promise<void>;
  update: { status(): UpdateStatus; check(): Promise<UpdateStatus>; install(): Promise<UpdateStatus> };
  chooseFolder(): Promise<string | null>;
};

export async function startBridge(handlers: BridgeHandlers) {
  const token = randomUUID();
  const server = http.createServer(async (req, res) => {
    const json = (status: number, body?: unknown) => res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
    if (!req.url?.startsWith(`/${token}/`) || req.headers.origin) return json(403);
    const route = `${req.method} ${req.url.slice(token.length + 1)}`;
    try {
      if (route === "POST /return") {
        const path = req.headers["x-moneo-return"];
        if (typeof path !== "string" || !RETURN_PATH.test(path)) return json(400);
        await handlers.onReturn(path);
        return json(204);
      }
      if (route === "GET /update") return json(200, handlers.update.status());
      if (route === "POST /update/check") return json(200, await handlers.update.check());
      if (route === "POST /update/install") return json(200, await handlers.update.install());
      if (route === "POST /choose-folder") return json(200, { path: await handlers.chooseFolder() });
      return json(404);
    } catch { return json(503); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`,
    close: () => { server.close(); server.closeAllConnections(); },
  };
}
