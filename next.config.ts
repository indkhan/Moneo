import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// The desktop app (scripts/desktop/build.mjs) runs a self-contained server copied out of the build.
const desktop = process.env.MONEO_DESKTOP_BUILD === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // npm run qa:server builds into its own folder, so it can run beside `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // `npm run dev` also answers phone access through Tailscale.
  allowedDevOrigins: ["**.ts.net"],
  // Reuse visited pages briefly too, so returning to Overview needs no server round trip.
  // Server actions invalidate affected pages; external updates appear within 30 seconds.
  // The proxy buffers request bodies; chat attachments go up to 25 MB.
  experimental: { staleTimes: { dynamic: 30, static: 30 }, proxyClientMaxBodySize: "26mb" },
  // The card sandbox loads its QuickJS WASM from its own package at runtime; bundling would move the file.
  // Claude's Agent SDK starts its bundled Claude Code binary from its own platform package.
  serverExternalPackages: ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "ai-sdk-provider-claude-code", "@anthropic-ai/claude-agent-sdk", "unpdf", "@napi-rs/canvas"],
  ...(desktop && {
    output: "standalone" as const,
    // Files read from disk at runtime, which tracing cannot see. Workflow's local world checks its data
    // folder against its own package.json version.
    outputFileTracingIncludes: {
      "/*": ["node_modules/echarts/dist/echarts.min.js", "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/**/*", "node_modules/@workflow/*/package.json",
        `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}*/**/*`],
    },
  }),
};

export default withWorkflow(nextConfig);
