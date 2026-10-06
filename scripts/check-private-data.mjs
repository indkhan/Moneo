import { execFileSync } from "node:child_process";

// Inspect index paths only: never read or print private source data.
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0");
if (paths.some((path) => /\.(csv|xlsx?|ofx|qfx|qif|mt940)$/i.test(path) || /(^|\/)(\.private-inputs|\.private-evidence|\.qa)(\/|$)/.test(path))) {
  console.error("Private financial input gate: remove tracked financial exports; use ignored private inputs or inline synthetic fixtures.");
  process.exitCode = 1;
}
