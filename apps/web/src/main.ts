// E01-S01 production entrypoint: listen on PORT (default 3000). Fails fast
// when the port is already in use; logs only the bound address and release,
// never env values or request data.

import { createApp } from "./server.ts";

const port = Number(process.env["PORT"] ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("E01-S01: PORT must be an integer 1-65535.");
  process.exit(1);
}

const server = createApp();
server.on("clientError", (_err, socket) => socket.destroy());
server.listen(port, "0.0.0.0", () => {
  const info = `${process.env["APP_RELEASE"] ?? "dev"}`;
  console.log(`moneo-web listening on :${port} release=${info}`);
});
