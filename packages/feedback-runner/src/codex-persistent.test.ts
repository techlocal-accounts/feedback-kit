import { describe, expect, it } from 'vitest';
import { PersistentCodexTaskAdapter, usageTotal, appServerRequestTimeoutMs } from './codex-persistent.js';
describe('persistent investigation budgets',()=>{
 it('bounds cold initialization and thread creation separately from routine requests',()=>{
  expect(appServerRequestTimeoutMs('initialize')).toBe(120000);
  expect(appServerRequestTimeoutMs('thread/start')).toBe(120000);
  expect(appServerRequestTimeoutMs('turn/start')).toBe(30000);
 });
 it('uses cumulative total usage, including cached input',()=>{
  expect(usageTotal({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:456,cachedInputTokens:400},last:{totalTokens:1}}}})).toBe(456);
  expect(usageTotal({method:'item/completed',params:{tokenUsage:{total:{totalTokens:456}}}})).toBeNull();
  expect(usageTotal({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:-1}}}})).toBeNull();
 });
 it('rejects unbounded and invalid model budgets',()=>{
  for(const tokenBudget of [0,-1,500001,NaN])expect(()=>new PersistentCodexTaskAdapter({executable:'codex',codexHome:'/tmp/test',tokenBudget,onThread:async()=>{},onUsage:async()=>{}})).toThrow();
 });
 it('allows room for a repository implementation, helpers and independent review',()=>{
  expect(()=>new PersistentCodexTaskAdapter({executable:'codex',codexHome:'/tmp/test',tokenBudget:500000,onThread:async()=>{},onUsage:async()=>{}})).not.toThrow();
 });
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(mode: 'complete'|'budget'|'child-budget') {
 const root=await mkdtemp(join(tmpdir(),'incident-transport-'));
 const checkout={path:join(root,'repo'),baseSha:'a'.repeat(40)};
 const home=join(root,'config');await mkdir(home);await writeFile(join(home,'config.toml'),'');
 await mkdir(checkout.path);await mkdir(join(root,'control.git'));
 await writeFile(join(checkout.path,'.git'),`gitdir: ${join(root,'control.git')}\n`);
 const marker=join(root,'receipt');const executable=join(root,'codex-fixture');
 await writeFile(executable,`#!/usr/bin/env node
const fs=require('fs');fs.writeFileSync(${JSON.stringify(join(root,'cli-args.json'))},JSON.stringify(process.argv.slice(2)));
if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.162.0');process.exit(0)}
if(process.argv.includes('mcp')){process.stdout.write('[]');process.exit(0)}
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');let buffer='';
process.stdin.on('data',chunk=>{buffer+=chunk;let lines=buffer.split('\\n');buffer=lines.pop();for(const l of lines){const m=JSON.parse(l);
 if(!m.id)continue;
 if(m.method==='thread/start'){fs.writeFileSync(${JSON.stringify(join(root,'model-params.json'))},JSON.stringify(m.params));send({id:m.id,result:{thread:{id:'saved-thread'}}});continue;}
 if(m.method==='turn/start'){
  if(!fs.existsSync(${JSON.stringify(marker)})){send({id:m.id,error:{message:'Receipt missing'}});continue;}
  send({id:m.id,result:{}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'saved-thread',tokenUsage:{total:{totalTokens:${mode==='budget'?600:100}}}}});
  ${mode==='child-budget'?`send({method:'thread/tokenUsage/updated',params:{threadId:'child-thread',tokenUsage:{total:{totalTokens:600}}}});`:''}
  ${mode==='complete'?`send({method:'item/completed',params:{threadId:'saved-thread',item:{type:'agentMessage',phase:'final_answer',text:'Verified fixture'}}});send({method:'turn/completed',params:{threadId:'saved-thread',turn:{status:'completed',items:[]}}});`:''}
  continue;
 }
 send({id:m.id,result:{}});
}});
`,{mode:0o700});
 return {root,checkout,home,marker,executable};
}
const claim={reportId:'fixture',runId:'run',fence:'fence',kind:'incident' as const,leaseMs:120000,task:'Synthetic transport verification',observedRelease:{commitSha:'a'.repeat(40)}};
it('persists the thread before starting a turn and handles streamed final items',async()=>{
 const f=await fixture('complete');const usage:number[]=[];
 try{
 const adapter=new PersistentCodexTaskAdapter({executable:f.executable,codexHome:f.home,tokenBudget:500,
  onThread:async(_role,id)=>{await writeFile(f.marker,id);},onUsage:async n=>{usage.push(n);}});
 await adapter.implement({claim,checkout:f.checkout,signal:new AbortController().signal});
 expect(JSON.parse(await readFile(join(f.root,'model-params.json'),'utf8'))).toMatchObject({model:'gpt-6.1-sol',config:{model_reasoning_effort:'high'}});
 expect(JSON.parse(await readFile(join(f.root,'cli-args.json'),'utf8'))).toContain('features.code_mode_host=true');
 expect(await readFile(f.marker,'utf8')).toBe('saved-thread');expect(usage.at(-1)).toBe(100);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('terminates when cumulative usage reaches the budget',async()=>{
 const f=await fixture('budget');const usage:number[]=[];
 try{
 const adapter=new PersistentCodexTaskAdapter({executable:f.executable,codexHome:f.home,tokenBudget:500,
  onThread:async(_role,id)=>{await writeFile(f.marker,id);},onUsage:async n=>{usage.push(n);}});
 await expect(adapter.implement({claim,checkout:f.checkout,signal:new AbortController().signal})).rejects.toThrow('Budget reached');
 expect(usage.at(-1)).toBe(600);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

it('enables at most two helpers and pins their model and reasoning without widening integrations',async()=>{
 const f=await fixture('complete');
 try {
 const adapter=new PersistentCodexTaskAdapter({executable:f.executable,codexHome:f.home,tokenBudget:500,
 executionSettings:{model:'gpt-6-astra',reasoningEffort:'max',subagents:'auto'},
 onThread:async(_role,id)=>{await writeFile(f.marker,id);},onUsage:async()=>{}});
 await adapter.implement({claim,checkout:f.checkout,signal:new AbortController().signal});
 const args=JSON.parse(await readFile(join(f.root,'cli-args.json'),'utf8'));
 expect(args).toContain('agents.enabled=true');expect(args).toContain('agents.max_concurrent_threads_per_session=2');
 expect(args).toContain('agents.default_subagent_model="gpt-6-astra"');
 expect(args).toContain('agents.default_subagent_reasoning_effort="max"');
 for(const feature of ['apps','hooks','plugins','computer_use','browser_use','request_permissions_tool'])expect(args[args.indexOf(feature)-1]).toBe('--disable');
 expect(args).toContain('approval_policy="never"');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

it('counts helper usage toward the shared budget and aborts all work',async()=>{
 const f=await fixture('child-budget');const usage:number[]=[];
 try {
 const adapter=new PersistentCodexTaskAdapter({executable:f.executable,codexHome:f.home,tokenBudget:500,executionSettings:{subagents:'auto'},onThread:async(_role,id)=>{await writeFile(f.marker,id);},onUsage:async n=>{usage.push(n);}});
 await expect(adapter.implement({claim,checkout:f.checkout,signal:new AbortController().signal})).rejects.toThrow('Budget reached');
 expect(usage.at(-1)).toBe(700);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
