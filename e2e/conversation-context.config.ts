import {defineConfig} from '@playwright/test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
process.loadEnvFile('.env');
export default defineConfig({
 testDir:'.',testMatch:'conversation-context.integration.ts',workers:1,retries:0,expect:{timeout:20000},
 use:{baseURL:'http://localhost:3025',trace:'retain-on-failure'},outputDir:resolve('.qa/mne025-browser-results-'+Date.now()),
 webServer:{cwd:process.cwd(),command:'node node_modules/next/dist/bin/next start -p 3025',url:'http://localhost:3025/login',reuseExistingServer:false,timeout:120000,
  env:{OPENROUTER_MODEL:'qa/mne025:free',OPENROUTER_API_KEY:'local-controlled-fixture',NODE_OPTIONS:'--import '+pathToFileURL(resolve('e2e/conversation-context-fetch.mjs')).href}},
});
