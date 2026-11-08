// Records real Moneo screens for the launch video: one page, in a real browser, with a visible cursor.
// Frames come from Chrome's screencast at 2x, so the edit can zoom in sharply. The frames and an index with
// their times land in promo/public/rec/<shot>/; call audio lands next to them.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

export const APP = "http://localhost:3110";
const VIEW = { width: 1440, height: 810 };

const cursorScript = () => {
  // Only the top page: artifacts run in sandboxed frames with no storage.
  if (window !== window.top) return;
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.id = "demo-cursor";
    dot.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24" style="filter:drop-shadow(0 3px 6px rgb(0 0 0/.55))"><path d="M5 3l14 8.2-6.1 1.4L9.6 19z" fill="#fff" stroke="#0f1011" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    dot.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:scale .08s;";
    const saved = JSON.parse(sessionStorage.getItem("demo-cursor") ?? "[720,700]");
    dot.style.translate = `${saved[0] - 6}px ${saved[1] - 5}px`;
    document.documentElement.append(dot);
    window.__cursor = (x, y) => { dot.style.translate = `${x - 6}px ${y - 5}px`; sessionStorage.setItem("demo-cursor", JSON.stringify([x, y])); };
    addEventListener("mousedown", () => { dot.style.scale = ".8"; }, true);
    addEventListener("mouseup", () => { dot.style.scale = "1"; }, true);
  });
};

/** Copies the call's microphone and Moneo's voice into recorders, so the video can use the real audio. */
const callAudioScript = () => {
  window.__audio = [];
  const capture = (track, who) => {
    const recorder = new MediaRecorder(new MediaStream([track]), { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
    const entry = { who, startedAt: Date.now(), chunks: [], recorder };
    recorder.ondataavailable = event => entry.chunks.push(event.data);
    recorder.start(1000);
    window.__audio.push(entry);
  };
  const addTrack = RTCPeerConnection;
  window.RTCPeerConnection = class extends addTrack {
    constructor(...args) {
      super(...args);
      this.addEventListener("track", event => { if (event.track.kind === "audio") capture(event.track, "moneo"); });
      const create = this.createDataChannel.bind(this);
      this.createDataChannel = (...rest) => {
        const channel = create(...rest);
        channel.addEventListener("message", message => { try { const data = JSON.parse(message.data); if (data.type === "session.output_transcript.delta") console.log("[spoke]" + data.delta); } catch { /* not JSON */ } });
        return channel;
      };
    }
  };
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    const stream = await getUserMedia(constraints);
    const track = stream.getAudioTracks()[0];
    if (track) capture(track.clone(), "you");
    return stream;
  };
};

export async function openBrowser({ micWav, viewport = VIEW, scale = 2, colorScheme = "dark" } = {}) {
  const args = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  if (micWav) args.push(`--use-file-for-fake-audio-capture=${micWav}`);
  const browser = await chromium.launch({ args, channel: "chromium" });
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme, permissions: ["microphone"], locale: "en-GB", timezoneId: "Europe/Berlin" });
  await context.addInitScript(cursorScript);
  if (micWav) await context.addInitScript(callAudioScript);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", error => console.log("page error:", error.message.slice(0, 200)));
  return { browser, context, page, viewport, scale };
}

/** Starts recording; `await stop()` finishes the shot and writes its index. */
export async function record({ page, context, viewport, scale }, shot) {
  const dir = `promo/public/rec/${shot}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await context.newCDPSession(page);
  const frames = [];
  let first = null;
  cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    first ??= metadata.timestamp;
    const name = `${String(frames.length).padStart(5, "0")}.jpg`;
    writeFileSync(`${dir}/${name}`, Buffer.from(data, "base64"));
    frames.push({ f: name, t: Math.round((metadata.timestamp - first) * 1000) / 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: viewport.width * scale, maxHeight: viewport.height * scale, everyNthFrame: 2 });
  const marks = {};
  return {
    /** Names this moment, so the edit can find it. */
    mark(name) { marks[name] = first === null ? 0 : Math.round((Date.now() / 1000 - first) * 1000) / 1000; console.log(`${shot}: ${name} at ${marks[name]}s`); },
    epoch: () => first,
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      writeFileSync(`${dir}/index.json`, JSON.stringify({ frames, marks, epoch: first, width: viewport.width, height: viewport.height, duration: frames.at(-1)?.t ?? 0 }));
      console.log(`${shot}: ${frames.length} frames over ${frames.at(-1)?.t}s (${(frames.length / (frames.at(-1)?.t || 1)).toFixed(1)} fps)`);
    },
  };
}

/** Glides the cursor to a point with an ease, like a hand. */
export async function glide(page, x, y, ms = 650) {
  const from = await page.evaluate(() => JSON.parse(sessionStorage.getItem("demo-cursor") ?? "[720,700]"));
  const steps = Math.max(6, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const p = i / steps, eased = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
    const at = [from[0] + (x - from[0]) * eased, from[1] + (y - from[1]) * eased];
    await page.mouse.move(at[0], at[1]);
    await page.evaluate(([left, top]) => window.__cursor?.(left, top), at);
    await page.waitForTimeout(ms / steps);
  }
}

/** Moves to an element's centre and clicks it. */
export async function tap(page, locator, ms) {
  await locator.waitFor({ state: "visible" });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, ms);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
}

export async function slowType(page, text, delay = 28) {
  await page.keyboard.type(text, { delay });
}

/** Scrolls by a distance over a time, smoothly. */
export async function scroll(page, distance, ms = 1400) {
  const steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps, last = (i - 1) / steps, ease = v => (v < 0.5 ? 2 * v * v : 1 - (-2 * v + 2) ** 2 / 2);
    await page.mouse.wheel(0, distance * (ease(p) - ease(last)));
    await page.waitForTimeout(16);
  }
}

/** Saves the recorded call audio as webm files; returns who started when (epoch ms). */
export async function saveCallAudio(page, shot) {
  const saved = await page.evaluate(async () => {
    const encode = blob => new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.readAsDataURL(blob); });
    return Promise.all(window.__audio.map(async entry => {
      if (entry.recorder.state !== "inactive") { await new Promise(resolve => { entry.recorder.onstop = resolve; entry.recorder.stop(); }); }
      return { who: entry.who, startedAt: entry.startedAt, data: await encode(new Blob(entry.chunks, { type: "audio/webm" })) };
    }));
  });
  const dir = `promo/public/rec/${shot}`;
  const index = saved.map((entry, i) => {
    const file = `${entry.who}-${i}.webm`;
    writeFileSync(`${dir}/${file}`, Buffer.from(entry.data, "base64"));
    return { who: entry.who, startedAt: entry.startedAt, file };
  });
  writeFileSync(`${dir}/audio.json`, JSON.stringify(index));
  console.log(`${shot}: saved audio`, index.map(entry => entry.file).join(", "));
  return index;
}
