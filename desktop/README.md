# Moneo Desktop

An Electron app that runs Moneo with its own private database on the owner's computer: no Docker,
Node.js, terminal or `.env`. The source setup (`npm run setup`, `npm run dev`) is unchanged.

## Build

```sh
node scripts/desktop/fetch-backend.mjs --platform win-x64   # native backend + mkcert → desktop/.build (see that script)
npm run desktop:build                    # Next.js standalone server + migrations → desktop/.build, main process → desktop/dist
npm run desktop:dev                      # run Electron on the unpacked build
npm run desktop:dist                     # installers → desktop/release (Windows NSIS, macOS dmg+zip, Linux AppImage+deb)
npm run desktop:smoke                    # drive the packaged app (desktop/release/*-unpacked) end to end
```

`desktop:build` runs `next build` with `MONEO_DESKTOP_BUILD=1` (standalone output in `.next-desktop/`, so
`.next` is untouched) and every `NEXT_PUBLIC_*` variable unset. It refuses to run when a `.env*` file
in the checkout sets `NEXT_PUBLIC_*` (Next.js would bake those addresses in), and fails if a local
Supabase address ends up in the output anyway.

Packages are unsigned by default. With `CSC_LINK` and `CSC_KEY_PASSWORD` set, electron-builder signs;
on macOS `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` also notarize. Unsigned macOS
builds get an ad-hoc signature. Package each platform on that platform (`npm run desktop:dist -- --win`,
`--mac`, `--linux`); the macOS and Linux backend needs a native addon built there.

## Where things live

- Package: `app.asar` holds only `dist/`, `setup/` and the icon. Next to it: `app/` (Next server),
  `migrations/`, `bootstrap/`, `backend/<os>-<arch>/`, `storage-api/`.
- Per user: the Electron user-data folder (`MONEO_DESKTOP_HOME` overrides it): `config.json` (backend
  secrets), `shell.json` (app port, tray notice, last backup), `postgres/`, `storage/`, `data/`
  (ChatGPT sign-in, bank certificate), `backups/`, `logs/`, `chromium/` (the window's own cookies).

The app listens on `http://localhost:47300` (chosen once, then kept: phone access, Scalable's return
address and ChatGPT's callback name it). If it is taken on the first run, a free port is saved instead.

## Behaviour

- Start: a small status window shows each step (the first run says it is creating a private database),
  then the app window opens Home. On failure it offers Try again, Open logs folder, Restore from backup, Quit.
- Closing the window keeps Moneo in the tray, so background syncs and phone access keep working.
  Quit (tray, Cmd+Q, `Moneo --quit`, OS shutdown) stops the server, then the database, then exits.
- Daily automatic backup while running; Back up now, Open backups folder and Restore from backup in the tray.
- Sign-ins (ChatGPT, banks, Scalable) open in the system browser and return to Moneo's loopback
  callbacks. The callback then opens its result (Import or Settings) in the app window and brings it
  to the front; the browser tab says to continue in Moneo. The server reaches the window through a
  loopback address that is random for each launch and refuses browser requests (`src/bridge.ts`);
  if the window cannot take it, the browser shows the result as in a source checkout. Every other address also goes to the browser
  (https only). The window allows only the microphone and copying, for Moneo's own pages.
- Updates: Settings → App updates checks the newest published GitHub release only when the owner
  asks (`src/updates.ts`, electron-updater). On Windows and with the AppImage, Update downloads it,
  quits Moneo cleanly, installs it and starts Moneo again; data stays in the user folder, and a pending
  migration makes a `pre-upgrade` backup first. macOS (unsigned) and `.deb` installs open the release
  page to download instead. Draft and pre-releases are never offered. `npm run desktop:dist` writes
  the `latest*.yml` files the check reads; the release workflow uploads them with the installers.

## Releasing

Push a `v*` tag matching `desktop/package.json`'s version (bump it first). The Desktop workflow builds
every platform and drafts a release with the installers, `latest*.yml`, blockmaps and `SHA256SUMS.txt`.
Publish the draft on GitHub; from then on, Settings → App updates offers it to installed apps.

### Bank return certificate

Enable Banking returns to `https://localhost:3443`. On every start Moneo makes that certificate with the
bundled mkcert if it is missing (its signing authority lives in the user folder, `mkcert/`); nothing is
trusted yet. The first time the owner opens a bank's consent page, Moneo explains why and asks the
computer to trust that authority once: Windows shows its own confirmation (current user's store),
macOS asks for the login keychain password, Linux adds it to the browsers' NSS store (needs `certutil`).

## Security fuses

For a private copied-data preview, launch the desktop executable with `MONEO_DESKTOP_PREVIEW=1`.
This runtime-only flag prevents persisted Workflow recovery, the scheduler and the bank callback
listener from starting, and skips automatic bank/Scalable sync when opening a page. It does not
block network requests triggered by explicit actions in the app, and is
not an offline mode. Normal desktop launches and source development keep their usual behavior.

RunAsNode, `NODE_OPTIONS` and `--inspect` are off; cookie encryption, asar-only loading and embedded asar
integrity are on. The smoke test reads them back from the packaged executable. Because `--inspect` is off,
Playwright's `_electron.launch` cannot attach, so the smoke test drives the app over
`--remote-debugging-port` instead. DevTools are off in packaged builds unless `MONEO_DESKTOP_DEBUG=1`.
