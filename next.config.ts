import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pages prefetched on nav-link intent (components/intent-link.tsx) and pages visited are reused for
  // 30 s, so going back to a page is instant. Server actions clear this cache; the import page clears it
  // when an import settles. Background agent runs can leave a revisited page up to 30 s behind.
  experimental: { staleTimes: { static: 30, dynamic: 30 } },
};

export default withWorkflow(nextConfig);
