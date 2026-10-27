import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pages prefetched on nav-link intent (components/intent-link.tsx) are reused for at most 30 s,
  // the minimum Next allows; visited dynamic pages keep the default of always re-rendering.
  experimental: { staleTimes: { static: 30 } },
};

export default withWorkflow(nextConfig);
