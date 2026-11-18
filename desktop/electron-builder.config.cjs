/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS config, loaded by electron-builder */
const signed = Boolean(process.env.CSC_LINK);
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
const version = process.env.MONEO_DESKTOP_VERSION;
const testInstaller = process.env.MONEO_DESKTOP_TEST_INSTALLER === "1";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: testInstaller ? "app.moneo.desktop.qa" : "app.moneo.desktop",
  productName: testInstaller ? "Moneo QA" : "Moneo",
  copyright: "Copyright © 2026 Moneo contributors",
  electronVersion: require("../node_modules/electron/package.json").version,
  directories: { output: process.env.MONEO_DESKTOP_RELEASE_DIR || "release", buildResources: "icons" },
  ...((version || testInstaller) && { extraMetadata: { ...(version && { version }), ...(testInstaller && { name: "moneo-desktop-qa", productName: "Moneo QA" }) } }),
  files: ["package.json", "dist/**", "setup/**", "icons/icon.png"],
  asar: true,
  publish: [{ provider: "github", owner: "indkhan", repo: "Moneo", releaseType: "release" }],
  npmRebuild: false,
  nodeGypRebuild: false,
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
    target: ["dmg", "zip"],
    category: "public.app-category.finance",
    icon: "icons/icon.png",
    hardenedRuntime: true,
    entitlements: require("node:path").join(__dirname, "electron-builder.entitlements.mac.plist"),
    entitlementsInherit: require("node:path").join(__dirname, "electron-builder.entitlements.mac.plist"),
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
