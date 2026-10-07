// Real React/CodeMirror components; deterministic HTTP fixtures, not deployed DB acceptance.
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
import { resolve } from "node:path";

const manifest = { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" };
const source = label => `(input) => ({ summary: "${label}" })`;
const row = (version, label = `History ${version}`) => ({ id: `v${version}`, version, status: "validated", error: null, created_at: "synthetic", manifest, source: source(label) });
const modules = {
  "fixture:navigation": 'export const useRouter = () => ({ refresh: () => window.refreshFixture(), push: url => {window.pushedUrl = url;} });',
  "fixture:dynamic": 'import React from "react"; export default loader => { const Component = React.lazy(() => loader().then(defaultExport => ({default: defaultExport}))); return props => React.createElement(React.Suspense, {fallback: "Loading source editor"}, React.createElement(Component, props)); };',
  "/fixture.js": `import React from "react"; import {createRoot} from "react-dom/client";
    import {VersionEditor} from "/app/ai/library/version-editor.tsx";
    import {GenerateCalculatorForm} from "/app/ai/library/generate-calculator-form.tsx";
    import {GenerationActions} from "/app/ai/activity/generation/[id]/generation-actions.tsx";
    import {RenameArtifactForm} from "/app/ai/library/rename-form.tsx";
    function Fixture() { const [props, update] = React.useState(window.initialFixture); window.updateFixture = update;
      return React.createElement(React.Fragment, null, React.createElement(RenameArtifactForm, {artifactId:props.artifactId,activeVersionId:props.activeVersionId,name:props.currentName,action:async form => {window.renameBody=Object.fromEntries(form);}}), React.createElement(VersionEditor, props), React.createElement(GenerateCalculatorForm, {artifactId: props.artifactId, kind: "custom_comparison", activeVersionId: props.activeVersionId}), React.createElement("section", {"aria-label":"Retained draft"}, React.createElement(GenerationActions, {id:"retained",artifactId:props.artifactId,purpose:"calculator",status:"completed",activeVersionId:props.activeVersionId,result:{source:'input => ({summary:"Retained"})',manifest:${JSON.stringify(manifest)},validation:{ok:true},baseVersionId:"v1"}}))); }
    createRoot(document.getElementById("root")).render(React.createElement(Fixture));`,
};
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: "127.0.0.1", port: 3035, strictPort: true },
  resolve: { alias: { "@": resolve("."), "next/navigation": "fixture:navigation", "next/dynamic": "fixture:dynamic" } },
  esbuild: { jsx: "automatic" },
  plugins: [{ name: "artifact-fixtures", resolveId: id => id in modules ? id : undefined, load: id => modules[id],
    configureServer: server => { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next(); res.setHeader("content-type", "text/html");
      res.end('<html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
    }); },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const props = (version, label, versions = [row(version, label)]) => ({ currentName: label, artifactId: "synthetic", activeVersionId: `v${version}`, currentSource: source(label), currentManifest: manifest, versions });
  let current = props(1, "A"), requests = [], nextVersion = 2, releaseGeneration, generationStarted = false, trustedHistory = false;
  await page.addInitScript(initial => { window.initialFixture = initial; window.refreshFixture = () => {}; }, current);
  await page.route("**/api/artifacts/**", async route => {
    const request = route.request();
    if (request.url().endsWith("/calculator/generate")) {
      const baseVersionId = "v1"; // Replayed retained result predates this request's props.
      generationStarted = true;
      await new Promise(resolve => { releaseGeneration = resolve; });
      return route.fulfill({ json: { source: source("Generated"), manifest, validation: { ok: true }, baseVersionId } });
    }
    if (request.method() === "GET") return route.fulfill({ json: { versions: [trustedHistory ? {...row(1, "Oldest"),manifest:{kind:"custom_comparison",runtime:"trusted"}} : row(1, "Oldest")], nextCursor: null, activeVersionId: current.activeVersionId } });
    const body = request.postDataJSON(); requests.push(body);
    if (body.expectedActiveVersionId !== current.activeVersionId) return route.fulfill({ status: 409, json: { error: "Active version changed. Local work preserved.", activeVersionId: current.activeVersionId } });
    const version = nextVersion++;
    current = { ...current, activeVersionId: `v${version}`, currentSource: body.source, currentManifest: body.manifest };
    return route.fulfill({ json: { status: "validated", version: { id: `v${version}`, version } } });
  });
  await page.goto("http://127.0.0.1:3035");
  const editor = page.getByRole("region", { name: "Edit calculator version" });
  const code = editor.getByRole("textbox", { name: "Calculator source", exact: true });
  const update = async value => { current = value; await page.evaluate(value => window.updateFixture(value), value); };
  await expect(code).toContainText('"A"');
  const name = page.getByLabel("Artifact name", {exact:true});
  await name.fill("Dirty rename");
  await update(props(2, "B"));
  await expect(name).toHaveValue("B");
  await page.locator("form").filter({has:name}).getByRole("button", {name:"Save new version",exact:true}).click();
  expect(await page.evaluate(() => window.renameBody)).toMatchObject({name:"B",expectedActiveVersionId:"v2"});
  console.log("PASS rename refresh discards old dirty name with clear copy and fresh CAS pairing");
  await expect(code).toContainText('"B"');
  console.log("PASS clean editor follows refreshed active source");
  await code.fill(source("Local"));
  await update(props(3, "C"));
  await expect(code).toContainText('"Local"');
  await expect(editor.getByRole("alert")).toContainText("changed");
  await editor.getByRole("button", { name: "Save new version", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("preserved");
  expect(requests.at(-1).expectedActiveVersionId).toBe("v2");
  await expect(code).toContainText('"Local"');
  await editor.getByRole("button", { name: "Replace current version with my edits", exact: true }).click();
  expect(requests.at(-1).expectedActiveVersionId).toBe("v3");
  await expect(editor.getByRole("status")).toContainText("activated");
  console.log("PASS dirty refresh preserves base/local work; explicit replacement uses reviewed current revision");
  await update(props(4, "D"));
  await editor.getByRole("button", { name: "Reload current version", exact: true }).click();
  await expect(code).toContainText('"D"');
  // A second tab activated E, without refreshing this tab's props.
  await code.fill(source("Tab local")); await name.fill("Dirty name before conflict"); current = props(5, "E");
  await page.evaluate(value => {window.refreshFixture=()=>window.updateFixture(value);}, current);
  await editor.getByRole("button", { name: "Save new version", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("preserved");
  await expect(code).toContainText('"Tab local"');
  await expect(name).toHaveValue("E");
  await page.evaluate(() => {window.refreshFixture=()=>{};});
  console.log("PASS unseen calculator409 refresh retains local source and resets rename draft to current saved name");
  await update(props(5, "E"));
  const generator = page.getByRole("region", { name: "AI-generated calculator" });
  await generator.getByRole("button", { name: "Use safe fallback", exact: true }).click();
  await update(props(6, "F"));
  await generator.getByRole("button", { name: "Save as new version", exact: true }).click();
  await expect(generator.getByRole("status")).toContainText("preserved");
  expect(requests.at(-1).expectedActiveVersionId).toBe("v5");
  await expect(generator.getByText("Proposed source (inspect before saving)")).toBeVisible();
  console.log("PASS old draft conflict retains draft and generation base");
  await generator.getByRole("button", { name: "Discard draft", exact: true }).click();
  await generator.getByLabel("What should the calculator compute?").fill("Synthetic comparison");
  await generator.getByRole("button", { name: "Suggest calculator", exact: true }).click();
  await expect.poll(() => generationStarted).toBe(true);
  await update(props(7, "G"));
  releaseGeneration();
  await expect(generator.getByText(source("Generated"), {exact: true})).toBeVisible();
  await generator.getByRole("button", { name: "Save as new version", exact: true }).click();
  await expect(generator.getByRole("status")).toContainText("preserved");
  expect(requests.at(-1).expectedActiveVersionId).toBe("v1");
  await generator.getByRole("button", { name: "Replace current version with this draft", exact: true }).click();
  await expect(generator.getByRole("status")).toContainText("Saved");
  expect(requests.at(-1).expectedActiveVersionId).toBe("v7");
  console.log("PASS in-flight/replayed generation retains server's original revision through refreshed props and explicit draft replacement");
  await update(props(25, "Newest", Array.from({length:20}, (_, i) => row(25-i))));
  await editor.getByRole("button", { name: "Load older versions", exact: true }).click();
  await expect(editor.getByRole("button", {name: "Restore v1 as a new version", exact: true})).toBeVisible();
  await editor.getByRole("button", { name: "Reload current version", exact: true }).click();
  await editor.getByRole("button", {name: "Restore v1 as a new version", exact: true}).click();
  await expect(editor.getByRole("status")).toContainText("activated");
  expect(requests.at(-1)).toMatchObject({ source: source("Oldest"), expectedActiveVersionId: "v25" });
  console.log("PASS version beyond first 20 reachable; restore submits a new CAS version");
  trustedHistory = true;
  await update(props(40, "Newest", Array.from({length:20}, (_, i) => row(40-i))));
  await editor.getByRole("button", { name: "Load older versions", exact: true }).click();
  await editor.getByRole("button", {name:"Restore v1 as a new version",exact:true}).click();
  await expect(editor.getByRole("status")).toContainText("activated");
  expect(requests.at(-1)).toEqual({restoreTrustedVersionId:"v1",expectedActiveVersionId:"v40"});
  console.log("PASS trusted v1 beyond twenty restores by identity without client source/manifest/status");
  await update(props(30, "Activity current"));
  const retained = page.getByRole("region", {name:"Retained draft",exact:true});
  await retained.getByRole("button", {name:"Save reviewed draft as a new version",exact:true}).click();
  await expect(retained.getByRole("status")).toContainText("preserved");
  expect(requests.at(-1).expectedActiveVersionId).toBe("v1");
  await retained.getByRole("button", {name:"Replace current version with retained draft",exact:true}).click();
  await expect.poll(() => requests.at(-1).expectedActiveVersionId).toBe("v30");
  await expect.poll(() => page.evaluate(() => window.pushedUrl)).toBe("/ai/library/synthetic");
  console.log("PASS Activity recovery retains original draft base and supports explicit replacement");
  await update(props(50, "Active", [{...row(49, "Rejected null"), status: "failed", manifest: null, error: "Invalid manifest"}]));
  const failedRow = editor.getByRole("listitem").filter({hasText:"v49"});
  await failedRow.getByText("Manifest", {exact:true}).click();
  await expect(failedRow.locator("pre").last()).toHaveText("null");
  await expect(failedRow.getByRole("button", {name:/Restore/})).toHaveCount(0);
  await failedRow.getByRole("button", {name:"Retry this version (load into editor)",exact:true}).click();
  await expect(editor.getByRole("textbox", {name:"Manifest (JSON)",exact:true})).toHaveValue("null");
  console.log("PASS raw null failed manifest review/retry preserves exact JSON and offers no restore");
} finally {
  await browser?.close(); await server.close();
}
