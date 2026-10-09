import {appendFileSync} from 'node:fs';
// Loaded only by the dedicated acceptance server. Real provider traffic fails closed.
const original = globalThis.fetch;
globalThis.fetch = async function(input, options) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.hostname !== 'openrouter.ai') return original(input, options);
  if (url.pathname === '/api/v1/models') return Response.json({data:[{id:'qa/mne025:free',name:'Controlled MNE025 transport',pricing:{prompt:'0',completion:'0'},supported_parameters:['tools','response_format']}]});
  if (url.pathname !== '/api/v1/chat/completions') throw new Error('MNE025 denies all other provider traffic');
  const body = JSON.parse(options?.body ?? await input.text());
  if (!JSON.stringify(body.messages).includes('MNE025')) throw new Error('Controlled transport only accepts the owned MNE025 fixture');
  appendFileSync('.qa/mne025-model-inputs.ndjson',JSON.stringify({pid:process.pid,body})+'\n');
  return Response.json({id:'mne025-local-'+Date.now(),model:'qa/mne025:free',object:'chat.completion',created:Math.floor(Date.now()/1000),choices:[{index:0,message:{role:'assistant',content:JSON.stringify({claims:[],interpretation:[],dialogue:{options:['compare_periods','forecast_assumptions']}})},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});
};
