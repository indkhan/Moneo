import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// Avoid synchronous process diagnostics for local queue port discovery.
if (process.env.NODE_ENV === "development" && !process.env.VERCEL && process.env.NEXT_PUBLIC_APP_URL) {
  process.env.WORKFLOW_LOCAL_BASE_URL ??= process.env.NEXT_PUBLIC_APP_URL;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default withWorkflow(nextConfig);
