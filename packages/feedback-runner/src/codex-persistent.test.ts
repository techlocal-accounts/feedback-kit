import { describe, expect, it } from 'vitest';
import { PersistentCodexTaskAdapter, usageTotal } from './codex-persistent.js';
describe('persistent investigation budgets',()=>{
 it('uses cumulative total usage, including cached input',()=>{
  expect(usageTotal({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:456,cachedInputTokens:400},last:{totalTokens:1}}}})).toBe(456);
  expect(usageTotal({method:'item/completed',params:{tokenUsage:{total:{totalTokens:456}}}})).toBeNull();
  expect(usageTotal({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:-1}}}})).toBeNull();
 });
 it('rejects unbounded and invalid model budgets',()=>{
  for(const tokenBudget of [0,-1,50001,NaN])expect(()=>new PersistentCodexTaskAdapter({executable:'codex',codexHome:'/tmp/test',tokenBudget,onThread:async()=>{},onUsage:async()=>{}})).toThrow();
 });
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(mode: 'complete'|'budget') {
 const root=await mkdtemp(join(tmpdir(),'incident-transport-'));
 const checkout={path:join(root,'repo'),baseSha:'a'.repeat(40)};
 const home=join(root,'config');await mkdir(home);await writeFile(join(home,'config.toml'),'');
 await mkdir(checkout.path);await mkdir(join(root,'control.git'));
 await writeFile(join(checkout.path,'.git'),`gitdir: ${join(root,'control.git')}\n`);
 const marker=join(root,'receipt');const executable=join(root,'codex-fixture');
 await writeFile(executable,`#!/usr/bin/env node
const fs=require('fs');
if(process.argv.includes('mcp')){process.stdout.write('[]');process.exit(0)}
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');let buffer='';
process.stdin.on('data',chunk=>{buffer+=chunk;let lines=buffer.split('\\n');buffer=lines.pop();for(const l of lines){const m=JSON.parse(l);
 if(!m.id)continue;
 if(m.method==='thread/start'){send({id:m.id,result:{thread:{id:'saved-thread'}}});continue;}
 if(m.method==='turn/start'){
  if(!fs.existsSync(${JSON.stringify(marker)})){send({id:m.id,error:{message:'Receipt missing'}});continue;}
  send({id:m.id,result:{}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'saved-thread',tokenUsage:{total:{totalTokens:${mode==='budget'?600:100}}}}});
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
