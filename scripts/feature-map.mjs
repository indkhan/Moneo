import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "FEATURES.md");
const problems = [];

const posix = path => path.split("\\").join("/");
const sourceFiles = (dir, keep) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
  const path = posix(join(dir, entry.name));
  if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourceFiles(path, keep);
  return keep(path) ? [path] : [];
}).sort();
const isSource = path => /\.(ts|tsx|mts)$/.test(path) && !/\.(test|live\.test)\.(ts|tsx)$/.test(path);
const parse = path => ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const walk = (node, visit) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
const nameOf = name => name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null;
const textOf = node => {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + "…";
  return null;
};
const property = (object, key) => object.properties.find(item => ts.isPropertyAssignment(item) && nameOf(item.name) === key)?.initializer;
const firstSentence = text => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s+[A-Z“"]|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > 100 ? `${sentence.slice(0, 97).trimEnd()}…` : sentence;
};
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const cell = text => String(text).replace(/\|/g, "\\|");
const table = (head, rows) => rows.length ? [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map(row => `| ${row.map(cell).join(" | ")} |`)].join("\n") : "_None._";
const code = text => `\`${text}\``;
const stem = word => word.toLowerCase().replace(/[^a-z]/g, "").replace(/(ization|ize|s)$/, "");

const routePath = file => {
  const segments = file.replace(/^app\//, "").split("/").slice(0, -1).filter(segment => !/^\(.*\)$/.test(segment));
  return `/${segments.join("/")}`;
};
const appFiles = sourceFiles("app", isSource);
const pages = appFiles.filter(file => /\/page\.tsx$/.test(file)).map(file => ({ file, path: routePath(file) })).sort((a, b) => cmp(a.path, b.path));
const routes = appFiles.filter(file => /\/route\.ts$/.test(file)).map(file => {
  const methods = [];
  walk(parse(file), node => {
    if (ts.isFunctionDeclaration(node) && node.name && /^(GET|POST|PUT|PATCH|DELETE)$/.test(node.name.text) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) methods.push(node.name.text);
    if (ts.isVariableStatement(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) node.declarationList.declarations.forEach(declaration => { const name = nameOf(declaration.name); if (name && /^(GET|POST|PUT|PATCH|DELETE)$/.test(name)) methods.push(name); });
  });
  return { file, path: routePath(file), methods: [...new Set(methods)].sort() };
}).sort((a, b) => cmp(a.path, b.path));

const navigation = [];
const palette = [];
for (const file of ["components/app-shell.tsx", "components/command-palette.tsx"]) {
  walk(parse(file), node => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const labelNode = property(node, "label");
    const label = textOf(labelNode) ?? (labelNode && ts.isPropertyAccessExpression(labelNode) ? `{${labelNode.getText()}}` : null), href = textOf(property(node, "href")), id = textOf(property(node, "id")), group = textOf(property(node, "group"));
    if (label && href) navigation.push({ label, href, go: textOf(property(node, "go")) });
    else if (label && id && group) palette.push({ id, label, group, hint: textOf(property(node, "hint")) });
  });
}
const uniqueBy = (items, key) => [...new Map(items.map(item => [key(item), item])).values()];
const navItems = uniqueBy(navigation, item => `${item.label}|${item.href}`).sort((a, b) => cmp(a.href, b.href) || cmp(a.label, b.label));
const paletteItems = uniqueBy(palette, item => item.id).sort((a, b) => cmp(a.group, b.group) || cmp(a.label, b.label));
for (const page of pages) {
  const bare = page.path.replace(/\/\[[^\]]+\]/g, "");
  if (!page.path.includes("[") && !navItems.some(item => item.href.split("?")[0] === page.path) && !["/setup"].includes(page.path)) page.unlisted = true;
  page.nav = navItems.filter(item => item.href.split("?")[0] === bare && !page.path.includes("["));
}

const widgetsFile = "lib/finance/dashboard.ts";
const widgets = [];
walk(parse(widgetsFile), node => {
  if (ts.isVariableDeclaration(node) && nameOf(node.name) === "BUILTIN_WIDGETS" && node.initializer && ts.isObjectLiteralExpression(node.initializer))
    node.initializer.properties.forEach(item => { if (ts.isPropertyAssignment(item)) widgets.push({ key: nameOf(item.name), label: textOf(item.initializer).split(",")[0] }); });
});
widgets.sort((a, b) => cmp(a.key, b.key));

const toolSources = [
  { file: "app/api/chat/route.ts", surface: "chat" },
  ...sourceFiles("lib/ai", isSource).filter(file => file !== "app/api/chat/route.ts").map(file => ({ file, surface: file === "lib/ai/artifact-agent.ts" ? "artifact builder" : "chat" })),
  { file: "lib/organize/organizer.ts", surface: "organizer (internal)" },
];
const tools = [];
for (const { file, surface } of toolSources) {
  walk(parse(file), node => {
    if (!ts.isPropertyAssignment(node) || !ts.isCallExpression(node.initializer) || !ts.isIdentifier(node.initializer.expression) || node.initializer.expression.text !== "tool") return;
    const name = nameOf(node.name), argument = node.initializer.arguments[0];
    if (name && argument && ts.isObjectLiteralExpression(argument)) tools.push({ name, surface, file, about: firstSentence(textOf(property(argument, "description"))) });
  });
}
tools.sort((a, b) => cmp(a.surface, b.surface) || cmp(a.name, b.name));
for (const [name, count] of Object.entries(Object.groupBy(tools.filter(tool => tool.surface === "chat"), tool => tool.name)).map(([name, list]) => [name, list.length])) if (count > 1) problems.push(`Chat tool "${name}" is registered ${count} times.`);

const cronFiles = routes.filter(route => route.path.startsWith("/api/cron/"));
let cronJobs = [];
walk(parse("lib/scheduler.ts"), node => {
  if (ts.isVariableDeclaration(node) && nameOf(node.name) === "CRON_JOBS") {
    const list = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
    if (ts.isArrayLiteralExpression(list)) cronJobs = list.elements.map(textOf).filter(Boolean);
  }
});
for (const job of cronJobs) if (!cronFiles.some(route => route.path === job)) problems.push(`lib/scheduler.ts runs ${job}, but app${job}/route.ts does not exist.`);
for (const route of cronFiles) if (!cronJobs.includes(route.path)) problems.push(`${route.file} is a cron route that lib/scheduler.ts (CRON_JOBS) never runs.`);

const workflowFiles = sourceFiles("workflows", isSource);
const workflows = workflowFiles.flatMap(file => {
  const names = [];
  walk(parse(file), node => {
    if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) names.push(node.name.text);
  });
  return names.map(name => ({ name, file, startedBy: [] }));
});
const codeFiles = ["app", "lib", "workflows"].flatMap(dir => sourceFiles(dir, isSource));
for (const file of codeFiles) {
  walk(parse(file), node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "start" || !node.arguments[0] || !ts.isIdentifier(node.arguments[0])) return;
    const workflow = workflows.find(item => item.name === node.arguments[0].text);
    if (workflow && !workflow.startedBy.includes(file)) workflow.startedBy.push(file);
  });
}
workflows.sort((a, b) => cmp(a.name, b.name)).forEach(item => item.startedBy.sort());

const undo = [];
for (const file of codeFiles) {
  const names = [];
  walk(parse(file), node => {
    if (ts.isFunctionDeclaration(node) && node.name && /undo/i.test(node.name.text) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) names.push(node.name.text);
  });
  if (names.length) undo.push({ file, names: names.sort() });
}
const undoRoutes = routes.filter(route => /undo/i.test(route.path));

const featureRows = pages.map(page => {
  const key = stem(page.path.split("/").filter(segment => !segment.startsWith("[")).at(-1) || "overview");
  const matches = word => !page.path.includes("[") && (stem(word) === key || (key === "" && stem(word) === "overview"));
  return [
    code(page.path),
    page.nav.map(item => item.go ? `${item.label} (G ${item.go.toUpperCase()})` : item.label).join(", ") || (page.unlisted ? "not in navigation" : ""),
    [...new Set(tools.filter(tool => tool.surface === "chat" && matches(tool.name.split("_")[0])).map(tool => tool.name))].map(code).join(", "),
    widgets.filter(widget => matches(widget.key)).map(widget => code(widget.key)).join(", "),
    code(page.file),
  ];
});

const sections = [
  "# Feature map",
  "Generated by `npm run feature-map` from the App Router tree, the chat tool registrations, the navigation and palette in `components/app-shell.tsx`, `BUILTIN_WIDGETS`, `CRON_JOBS` and `workflows/`. Do not edit by hand; `npm run lint` fails when it is stale. Chat tools and widgets are matched to a page when their name starts with the page's last path segment.",
  "## Pages\n" + table(["Route", "Navigation (shortcut)", "Chat tools", "Home widget", "File"], featureRows),
  "## Chat tools\nThe voice call hands every request to the same chat (`/api/chat`), so these are also the voice tools.\n\n" + table(["Tool", "Surface", "Does", "File"], tools.map(tool => [code(tool.name), tool.surface, tool.about, code(tool.file)])),
  "## Voice\nCall code: " + sourceFiles("lib/ai", isSource).filter(file => /\/(use-)?voice-/.test(file)).map(code).join(", ") + ".\n\n" + table(["Route", "Methods", "File"], routes.filter(route => route.path.startsWith("/api/voice")).map(route => [code(route.path), route.methods.join(", "), code(route.file)])),
  "## Home widgets\nDefined in " + code(widgetsFile) + "; AI-built cards also appear on the home grid as `card:<id>` (`/api/cards/[id]`).\n\n" + table(["Key", "Label"], widgets.map(widget => [code(widget.key), widget.label])),
  "## Command palette\nEvery page with a navigation label in Pages is also a palette command in group Pages.\n\n" + table(["Group", "Command", "Hint"], paletteItems.map(item => [item.group, item.label, item.hint ?? ""])),
  "## Background work\n" + table(["Cron route (hourly scheduler)", "File"], cronFiles.map(route => [code(route.path), code(route.file)])) + "\n\n" + table(["Workflow", "File", "Started by"], workflows.map(item => [code(item.name), code(item.file), item.startedBy.map(code).join(", ")])),
  "## Undo and reverse paths\n" + table(["File", "Undo functions"], undo.map(item => [code(item.file), item.names.map(code).join(", ")])) + (undoRoutes.length ? "\n\n" + table(["Route", "Methods"], undoRoutes.map(route => [code(route.path), route.methods.join(", ")])) : ""),
  "## API routes\n" + table(["Route", "Methods", "File"], routes.map(route => [code(route.path), route.methods.join(", "), code(route.file)])),
];
const map = `${sections.join("\n\n")}\n`;

if (problems.length) {
  console.error(`Feature map: ${problems.length} inconsistent registration(s):\n${problems.map(problem => `- ${problem}`).join("\n")}\nFix the registration, then run \`npm run feature-map\`.`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  const current = existsSync(output) ? readFileSync(output, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== map) {
    console.error(`FEATURES.md is out of date with the code. Run \`npm run feature-map\` and commit the result.`);
    process.exit(1);
  }
} else writeFileSync(output, map);
