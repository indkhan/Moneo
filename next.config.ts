import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const desktop = process.env.MONEO_DESKTOP_BUILD === "1";

const releasedVersion = (JSON.parse(readFileSync(path.join(__dirname, "desktop", "package.json"), "utf8")) as { version: string }).version;

const nextConfig: NextConfig = {
  env: { MONEO_VERSION: releasedVersion },
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["**.ts.net"],
  experimental: { staleTimes: { dynamic: 30, static: 30 }, proxyClientMaxBodySize: "26mb" },
  serverExternalPackages: ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "ai-sdk-provider-claude-code", "@anthropic-ai/claude-agent-sdk", "unpdf", "@napi-rs/canvas", "@huggingface/transformers"],
  ...(desktop && {
    output: "standalone" as const,
    outputFileTracingIncludes: {
      "/*": ["node_modules/echarts/dist/echarts.min.js", "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/**/*", "node_modules/@workflow/*/package.json",
        `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}*/**/*`,
        "node_modules/onnxruntime-node/package.json", "node_modules/onnxruntime-node/dist/**/*", `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/*`,
        "node_modules/onnxruntime-common/package.json", "node_modules/onnxruntime-common/dist/cjs/**/*"],
    },
  }),
};

export default withWorkflow(nextConfig);
