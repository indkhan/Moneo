import type { MetadataRoute } from "next";

// Lets Android and iOS (Add to Home Screen) install Moneo as a standalone app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Moneo — Personal Finance Workspace",
    short_name: "Moneo",
    description: "Understand your money, plan decisions, and build reusable financial tools with AI.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0f1011",
    theme_color: "#0f1011",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
