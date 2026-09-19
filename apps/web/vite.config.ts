import { defineConfig } from "vite";

export default defineConfig({
    root: "apps/web",
    build: {
        outDir: "dist",
        emptyOutDir: false,
        rollupOptions: {
            input: {
                "artifact-renderer-entry": "src/artifact-renderer.ts",
                "artifact-worker": "../worker/src/artifact-worker.ts",
            },
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "[name].js",
                assetFileNames: "[name].[ext]",
            },
        },
    },
    server: {
        port: 4174,
        headers: {
            "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'self'; img-src data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors http://localhost:3000;",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), clipboard-read=(), clipboard-write=()",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
        },
    },
});