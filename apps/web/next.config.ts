import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Next runs from apps/web, while shared server config lives at the workspace root.
const workspaceEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(workspaceEnv)) {
  process.loadEnvFile(workspaceEnv);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@moneo/ui", "@moneo/shared", "@moneo/db"],
};

export default nextConfig;
