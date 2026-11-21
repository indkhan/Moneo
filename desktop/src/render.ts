import { BrowserWindow } from "electron";
import { setTimeout as delay } from "node:timers/promises";
import type { RenderRequest, Rendered } from "./render-request";

const SETTLE_MS = 900;
const MAX_HEIGHT = 2400;

export async function renderPage(port: number, request: RenderRequest): Promise<Rendered> {
  const window = new BrowserWindow({ show: false, width: request.width, height: request.height, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    window.webContents.on("will-navigate", event => event.preventDefault());
    await window.loadURL(`http://localhost:${port}${request.path}`);
    await delay(SETTLE_MS);
    const result: unknown = await window.webContents.executeJavaScript(request.script);
    let height = request.height;
    if (request.full) {
      height = Math.min(MAX_HEIGHT, Math.max(request.height, Number(await window.webContents.executeJavaScript("document.documentElement.scrollHeight")) || request.height));
      window.setContentSize(request.width, height);
      await delay(SETTLE_MS / 3);
    }
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: request.width, height });
    return { png: image.toPNG().toString("base64"), result };
  } finally {
    window.destroy();
  }
}
