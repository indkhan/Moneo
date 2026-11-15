import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const desktop = process.env.MONEO_DESKTOP_BUILD === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["**.ts.net"],
  experimental: { staleTimes: { dynamic: 30, static: 30 }, proxyClientMaxBodySize: "26mb" },
  serverExternalPackages: ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "ai-sdk-provider-claude-code", "@anthropic-ai/claude-agent-sdk", "unpdf", "@napi-rs/canvas"],
  ...(desktop && {
    output: "standalone" as const,
    outputFileTracingIncludes: {
      "/*": ["node_modules/echarts/dist/echarts.min.js", "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/**/*", "node_modules/@workflow/*/package.json",
        `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}*/**/*`],
    },
  }),
};

export default withWorkflow(nextConfig);
