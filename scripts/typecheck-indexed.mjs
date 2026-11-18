import path from "node:path";
import ts from "typescript";

const configPath = path.resolve("tsconfig.indexed.json");
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  },
});
if (!config) throw new Error(`Cannot read ${configPath}`);

const covered = new Set(config.fileNames.map(file => path.resolve(file)));
const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
const errors = ts
  .getPreEmitDiagnostics(program)
  .filter(diagnostic => diagnostic.file && covered.has(path.resolve(diagnostic.file.fileName)));

if (errors.length > 0) {
  const host = {
    getCanonicalFileName: file => file,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => "\n",
  };
  console.error(ts.formatDiagnostics(errors, host));
  console.error(`${errors.length} error(s) in the folders listed in tsconfig.indexed.json.`);
  process.exit(1);
}
console.log(`Checked indexed access in ${covered.size} files.`);
