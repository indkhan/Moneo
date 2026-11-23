import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const tsc = fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript-native/package.json")));
const nativeOptions = [tsc, "--noEmit", "--noUncheckedSideEffectImports", "false", "--libReplacement", "true"];
const checks = [
  [...nativeOptions, "--types", "*", "--tsBuildInfoFile", "tsconfig.native.tsbuildinfo"],
  ["scripts/typecheck-indexed.mjs"],
  [...nativeOptions, "-p", "desktop", "--incremental"],
];

const results = await Promise.all(checks.map(args =>
  once(spawn(process.execPath, args, { stdio: "inherit" }), "exit"),
));
if (results.some(([code]) => code !== 0)) process.exitCode = 1;
