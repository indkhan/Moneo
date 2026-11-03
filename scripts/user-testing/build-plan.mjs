import {mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const artifactPath=process.env.ARTIFACT_TOOL_PATH??join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs');
const {Workbook}=await import(pathToFileURL(artifactPath).href);
mkdirSync('.qa/user-testing',{recursive:true});
import {personas,part1} from './plan-data-1.mjs';
import {part2} from './plan-data-2.mjs';
export const walkthroughs=[...part1,...part2].sort((a,b)=>a.id.localeCompare(b.id));
const headers=['case_id','walkthrough_id','persona_id','persona','walkthrough','step','viewport','preconditions','area','route','test_type','priority','action','expected_result','ux_judgment','status','actual_result','evidence','finding_ids'];
const records=walkthroughs.flatMap(w=>w.rows.map((r,i)=>({case_id:`${w.id}-${String(i+1).padStart(3,'0')}`,walkthrough_id:w.id,persona_id:w.persona,persona:personas[w.persona],walkthrough:w.title,step:i+1,viewport:w.viewport,preconditions:w.pre,area:r[0],route:r[1],test_type:r[2],priority:r[3],action:r[4],expected_result:r[5],ux_judgment:r[6],status:'NOT_RUN',actual_result:'Not executed yet',evidence:'',finding_ids:''})));
export function csv(rows,keys=Object.keys(rows[0]??{})){return '\uFEFF'+[keys,...rows.map(r=>keys.map(k=>r[k]??''))].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';}
const content=csv(records,headers);
const wb=await Workbook.fromCSV(content,{sheetName:'User testing'});
try { const result=await wb.export({format:'csv',sheetName:'User testing'});writeFileSync('.qa/user-testing/test-plan.csv',Buffer.from(await result.arrayBuffer())); }
catch(error){console.log('CSV export unavailable; preserving exact RFC4180 source used to author workbook:',error.message);writeFileSync('.qa/user-testing/test-plan.csv',content);}
writeFileSync('.qa/user-testing/cases.json',JSON.stringify(records,null,2));
console.log(JSON.stringify({cases:records.length,walkthroughs:walkthroughs.length,personas:Object.keys(personas).length}));

