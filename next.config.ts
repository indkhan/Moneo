import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pages prefetched on nav-link intent (components/intent-link.tsx) are reused for at most 30 s,
  // the minimum Next allows; visited dynamic pages keep the default of always re-rendering.
  experimental: { staleTimes: { static: 30 } },
  // The card sandbox loads its QuickJS WASM from its own package at runtime; bundling would move the file.
  serverExternalPackages: ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync"],
};

export default withWorkflow(nextConfig);
