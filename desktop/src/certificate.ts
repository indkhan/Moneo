import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { dataDir, home, log, platformKey, resources } from "./paths";

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
  try {
    mkdirSync(dataDir(), { recursive: true });
    mkdirSync(caRoot(), { recursive: true });
    await run(mkcert(), ["-cert-file", cert, "-key-file", key, "localhost", "127.0.0.1", "::1"], { env: env("system"), timeout: 30_000, windowsHide: true });
    log("Bank return certificate created");
    return true;
  } catch (error) {
    log(`Could not create the bank return certificate: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

export async function trustBankCertificate() {
  const rootCa = path.join(caRoot(), "rootCA.pem");
  if (!existsSync(rootCa)) return false;
  try {
    if (process.platform === "darwin") {
      const keychain = path.join(process.env.HOME ?? "", "Library", "Keychains", "login.keychain-db");
      await run("/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, rootCa], { timeout: 120_000 });
    } else {
      await run(mkcert(), ["-install"], { env: env(process.platform === "win32" ? "system" : "nss"), timeout: 120_000, windowsHide: true });
    }
    log("Bank return certificate trusted");
    return true;
  } catch (error) {
    log(`Could not trust the bank return certificate: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
