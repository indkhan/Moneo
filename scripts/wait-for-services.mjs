// CI gate helper: wait for the S3 endpoint and the clamd TCP port.
// No credentials or payloads are logged; only readiness lines. Fails the
// step (nonzero exit) after WAIT_TIMEOUT_MS so a stuck service is a red
// gate, never a silent skip.

import { connect } from "node:net";

const s3Endpoint = process.env["WAIT_S3_ENDPOINT"] ?? "http://localhost:9000";
const clamdHost = process.env["WAIT_CLAMD_HOST"] ?? "localhost";
const clamdPort = Number(process.env["WAIT_CLAMD_PORT"] ?? "3310");
const timeoutMs = Number(process.env["WAIT_TIMEOUT_MS"] ?? "240000");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function s3Live() {
  try {
    const res = await fetch(`${s3Endpoint.replace(/\/$/, "")}/`, { signal: AbortSignal.timeout(5000) });
    return res.status === 403;
  } catch {
    return false;
  }
}

async function clamdLive() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    const socket = connect({ host: clamdHost, port: clamdPort }, () => {
      socket.write("PING", () => undefined);
    });
    socket.setTimeout(5000, () => finish(false));
    socket.on("data", (data) => finish(String(data).includes("PONG")));
    socket.on("error", () => finish(false));
    socket.on("timeout", () => finish(false));
  });
}

const start = Date.now();
let s3Ready = false;
let clamdReady = false;
for (;;) {
  if (!s3Ready && (await s3Live())) {
    s3Ready = true;
    console.log("wait-for-services: s3 endpoint live");
  }
  if (!clamdReady && (await clamdLive())) {
    clamdReady = true;
    console.log("wait-for-services: clamd live");
  }
  if (s3Ready && clamdReady) {
    console.log(`wait-for-services: ready after ${Math.round((Date.now() - start) / 1000)}s`);
    process.exit(0);
  }
  if (Date.now() - start > timeoutMs) {
    console.error(`wait-for-services: timed out (s3=${s3Ready} clamd=${clamdReady})`);
    process.exit(1);
  }
  await sleep(5000);
}
