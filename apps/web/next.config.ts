import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@moneo/ui", "@moneo/shared", "@moneo/db"],
};

export default nextConfig;
