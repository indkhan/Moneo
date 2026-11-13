import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { dataDir, home, log, platformKey, resources } from "./paths";

// Enable Banking only returns to https addresses, so Moneo answers on https://localhost:3443
// (lib/bank/return-listener.ts) with a certificate from the bundled mkcert. Two steps:
// 1. ensureBankCertificate, silently on every start: makes the certificate (and a private signing
//    authority kept in the Moneo folder) so the listener can start. Nothing is trusted yet.
// 2. trustBankCertificate, the first time the owner opens a bank's consent page: asks the computer
//    to trust that authority, which shows the system's own confirmation once.
const run = promisify(execFile);

const mkcert = () => path.join(resources(), "backend", platformKey(), process.platform === "win32" ? "mkcert.exe" : "mkcert");
const caRoot = () => path.join(home(), "mkcert");
const files = () => ({ key: path.join(dataDir(), "localhost-key.pem"), cert: path.join(dataDir(), "localhost.pem") });

function env(trustStores: string) {
  return { ...process.env, CAROOT: caRoot(), TRUST_STORES: trustStores };
}

export async function ensureBankCertificate() {
  const { key, cert } = files();
  if (existsSync(key) && existsSync(cert)) return true;
  if (!existsSync(mkcert())) { log("mkcert is not bundled; bank connections cannot return to Moneo"); return false; }
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(caRoot(), { recursive: true });
  try {
    await run(mkcert(), ["-cert-file", cert, "-key-file", key, "localhost", "127.0.0.1", "::1"], { env: env("system"), timeout: 30_000, windowsHide: true });
    log("Bank return certificate created");
    return true;
  } catch (error) {
    log(`Could not create the bank return certificate: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** Trusts Moneo's own signing authority in the user's certificate store (not machine-wide). */
export async function trustBankCertificate() {
  const rootCa = path.join(caRoot(), "rootCA.pem");
  if (!existsSync(rootCa)) return false;
  try {
    if (process.platform === "darwin") {
      // mkcert -install would need sudo for the system keychain; the login keychain asks in a normal window.
      const keychain = path.join(process.env.HOME ?? "", "Library", "Keychains", "login.keychain-db");
      await run("/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, rootCa], { timeout: 120_000 });
    } else {
      // Windows: the current user's root store (Windows asks once). Linux: Chrome/Firefox's NSS store, which needs certutil.
      await run(mkcert(), ["-install"], { env: env(process.platform === "win32" ? "system" : "nss"), timeout: 120_000, windowsHide: true });
    }
    log("Bank return certificate trusted");
    return true;
  } catch (error) {
    log(`Could not trust the bank return certificate: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
