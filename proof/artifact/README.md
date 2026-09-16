# E00-S02 artifact boundary proof

This is a feasibility proof, not the production artifact runtime. It uses site-separated local hosts: the trusted host at `localhost:4173` and the credential-free renderer at `127.0.0.1:4174`. Generated JavaScript runs inside QuickJS/WASM in a dedicated, terminable worker and can emit only the bounded UI/state protocol. Auth0 is deliberately absent: current Auth0 session guidance separates the application session from the authorization-server session, and the Moneo contract keeps the artifact registrable site outside that relying-party boundary.

## Run

```powershell
npm ci
npm run test:artifact:install
npm run test:artifact
```

The last command builds bundled assets, starts both origins with production-equivalent CSP/Permissions-Policy headers, and runs the same hostile suite in Chromium, Firefox, and WebKit. `proof-output/` and Playwright failure artifacts are disposable and ignored.

## Pinned proof stack and measured host

- Node 22.23.2, npm 10.9.8, TypeScript 7.0.2, Vitest 5.0.1
- Playwright 1.62.0: Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5
- quickjs-emscripten 0.32.0; css-tree 3.2.1; Vite 8.3.0
- Windows 11 10.0.26200, 12th Gen Intel Core i5-12450HX, 16 GiB RAM

Playwright 1.63.0/WebKit 26.6 was rejected on this host: its Windows build reported missing `libxslt.dll`/`libwebp.dll` and exited `0xC0E90002` even after a forced reinstall. The smallest supported fallback, Playwright 1.62.0/WebKit 26.5, passed. Playwright WebKit is not branded Safari; Safari/macOS deployment qualification remains a later production gate.

## Enforced proof limits

- source: 2 MiB
- QuickJS heap: 16 MiB; stack: 512 KiB
- message: 1 MiB; rate: 100 messages/second
- execution/start ceiling: 5 seconds
- explicit Stop: asserted below 1 second

The WASM bytes are bundled into the worker asset as a data URL. Only the worker response permits `data:` in `connect-src` and `wasm-unsafe-eval`; the renderer page retains `connect-src 'none'` and `script-src 'self'`. External HTTP(S) still fails and generated code has no fetch/DOM/navigation/storage globals. A production bundler may pass a compiled `WebAssembly.Module` directly and restore literal worker `connect-src 'none'` without changing the VM boundary.

The proof deliberately keeps only a tiny HTML tag/attribute allowlist, CSS property/value AST allowlist, one trusted chart primitive, one synthetic read-only finance query, and host-memory state. Add breadth only when an R1 story consumes it. Production state persistence, tenant grants, deployed registrable domains, Safari, and independent runtime penetration review remain E05/E08 work.
