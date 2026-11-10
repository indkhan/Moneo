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
  experimental: { staleTimes: { dynamic: 30, static: 30 } },
  // The card sandbox loads its QuickJS WASM from its own package at runtime; bundling would move the file.
  serverExternalPackages: ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync"],
  ...(desktop && {
    output: "standalone" as const,
    // Files read from disk at runtime, which tracing cannot see. Workflow's local world checks its data
    // folder against its own package.json version.
    outputFileTracingIncludes: {
      "/*": ["node_modules/echarts/dist/echarts.min.js", "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/**/*", "node_modules/@workflow/*/package.json"],
    },
  }),
};

export default withWorkflow(nextConfig);
