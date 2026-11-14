/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS config, loaded by electron-builder */
// electron-builder config for Moneo Desktop (npm run desktop:dist, after npm run desktop:build).
// desktop/ is the app: only dist/, setup/ and the icon go into app.asar; the Next server, migrations
// and native backend are extraResources next to it. Unsigned unless signing credentials are in the
// environment (CSC_LINK + CSC_KEY_PASSWORD; on macOS also APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
// APPLE_TEAM_ID for notarization).
const signed = Boolean(process.env.CSC_LINK);
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
// Upgrade tests (scripts/desktop/package-upgrade.mjs) build a second version into a separate folder
// without touching desktop/package.json, and without Start menu or desktop shortcuts.
const version = process.env.MONEO_DESKTOP_VERSION;
const testInstaller = process.env.MONEO_DESKTOP_TEST_INSTALLER === "1";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: testInstaller ? "app.moneo.desktop.qa" : "app.moneo.desktop",
  productName: testInstaller ? "Moneo QA" : "Moneo",
  copyright: "Copyright © 2026 Moneo contributors",
  electronVersion: require("../node_modules/electron/package.json").version,
  directories: { output: process.env.MONEO_DESKTOP_RELEASE_DIR || "release", buildResources: "icons" },
  // A test build is a different app to Electron too: its own data folder (%APPDATA%\Moneo QA) and
  // single-instance lock, so nothing it starts (an update's restart, `--quit`) reaches the owner's Moneo.
  ...((version || testInstaller) && { extraMetadata: { ...(version && { version }), ...(testInstaller && { name: "moneo-desktop-qa", productName: "Moneo QA" }) } }),
  files: ["package.json", "dist/**", "setup/**", "icons/icon.png"],
  asar: true,
  // Writes latest*.yml next to the installers: the update check in Settings reads them from the
  // release (desktop/src/updates.ts). The CI release job uploads them; electron-builder publishes nothing.
  publish: [{ provider: "github", owner: "indkhan", repo: "Moneo", releaseType: "release" }],
  // desktop/package.json has no dependencies: everything the main process needs is bundled by esbuild.
  npmRebuild: false,
  nodeGypRebuild: false,
  // One entry from .build: electron-builder always drops the node_modules directly inside a `from`
  // folder, and the Next server and Storage API need theirs (here one level down).
  extraResources: [{
    from: ".build",
    to: ".",
    filter: ["app/**/*", "migrations/**/*", "bootstrap/**/*", "backend/${os}-${arch}/**/*", "storage-api/**/*"],
  }],
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableCookieEncryption: true,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "icons/icon.png",
    executableName: testInstaller ? "Moneo-QA" : "Moneo",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    include: "electron-builder.installer.nsh",
    ...(testInstaller && { createDesktopShortcut: false, createStartMenuShortcut: false }),
    artifactName: "Moneo-Setup-${version}-${arch}.${ext}",
  },
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }, { target: "zip", arch: ["arm64", "x64"] }],
    category: "public.app-category.finance",
    icon: "icons/icon.png",
    hardenedRuntime: true,
    entitlements: require("node:path").join(__dirname, "electron-builder.entitlements.mac.plist"),
    entitlementsInherit: require("node:path").join(__dirname, "electron-builder.entitlements.mac.plist"),
    // Ad-hoc signature without credentials (Apple Silicon refuses to run unsigned code).
    identity: signed ? undefined : "-",
    notarize: signed && notarize,
    extendInfo: { NSMicrophoneUsageDescription: "Moneo uses the microphone for voice conversations about your money." },
  },
  dmg: { artifactName: "Moneo-${version}-${arch}.${ext}" },
  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] }],
    category: "Office;Finance",
    icon: "icons/icon.png",
    executableName: "moneo",
    maintainer: "Moneo contributors",
    synopsis: "Personal finance that runs on your own computer",
  },
};
