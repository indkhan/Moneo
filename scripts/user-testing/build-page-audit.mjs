import { readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../../.qa/user-testing/', import.meta.url);
const directory = new URL('page-audits/', root);
const files = (await readdir(directory)).filter(file => file.endsWith('.md')).sort();
const rows = [];
const index = [];
for (const file of files) {
  const content = await readFile(new URL(file, directory), 'utf8');
  const title = content.split('\n')[0].replace(/^#\s*/, '').trim();
  let sections = [...content.matchAll(/^### (.+)\r?\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)];
  if (!sections.length) sections = [...content.matchAll(/^\d+\. \*\*(.+?)\*\*([\s\S]*?)(?=^\d+\. \*\*|^## |$(?![\s\S]))/gm)];
  if (!sections.length) sections = [...content.matchAll(/^\| ([A-Z][A-Z0-9-]+) \| (.+)\r?$/gm)];
  assert(sections.length, `No findings parsed: ${file}`);
  for (const section of sections) {
    rows.push([file.replace('.md', ''), title, section[1].trim(), section[2].trim(), `page-audits/${file}`]);
  }
  index.push(`- [${title}](page-audits/${file}) — ${sections.length} findings`);
}
assert.equal(files.length, 27, 'Expected a separate audit for every page');
const csv = [['page', 'page_review', 'finding', 'evidence_recommendation_acceptance', 'detailed_report'], ...rows]
  .map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
await writeFile(new URL('page-ui-ux-changes.csv', root), '\uFEFF' + csv + '\r\n');
await writeFile(new URL('PAGE-AUDIT-INDEX.md', root), `# Page-by-page UI/UX audit\n\n27 independent page reviews; ${rows.length} recommendations. These include observed issues and explicitly labeled source-supported concerns. They are not all reproduced defects. Consult each report's coverage limits before implementation. Related issues may overlap across pages.\n\n[Change CSV](page-ui-ux-changes.csv) · [Baseline report](REPORT.md) · [299-case plan](test-plan.csv) · [Execution results](execution-results.csv)\n\n${index.join('\n')}\n`);
console.log(`${files.length} page reviews; ${rows.length} recommendations exported`);
