// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runLocalFeedbackPoll,type FeedbackPublicationRecord} from './controller.js';
import type {LocalFeedbackRunnerConfig} from './index.js';
const claim={reportId:'report-1',runId:'run-1',fence:'fence-1',kind:'bug' as const,task:'PRIVATE REPORT TEXT',observedRelease:{},leaseMs:60_000};
function harness(){
 const config:LocalFeedbackRunnerConfig={queue:{claimNext:vi.fn(async()=>claim),owns:async()=>true,renew:async()=>true,finish:vi.fn(async()=>true),markAvailable:async()=>{}},
 git:{createIsolatedCheckout:async()=>({path:'/tmp/synthetic',baseSha:'a'.repeat(40)}),inspect:async()=>({headSha:'b'.repeat(40),changedPaths:['src/save.ts','src/save.test.ts']}),snapshot:async()=>({headSha:'b'.repeat(40),changedPaths:['src/save.ts','src/save.test.ts']}),publish:vi.fn(async()=>{}),discard:async()=>{}},
 codex:{implement:vi.fn(async()=>{}),review:async()=>({approved:true,reason:'Reviewed',releaseNote:'Saving works again.'})},validation:{prepare:async()=>{},focused:async()=>{},shared:async()=>{}},protectedPaths:[],verifyDelivery:async()=>null};return config;
}
async function temporary(test:(directory:string)=>Promise<void>){const p=await mkdtemp(join(tmpdir(),'feedback-controller-test-'));try{await test(p);}finally{await rm(p,{recursive:true,force:true});}}
describe('durable local feedback controller',()=>{
 it('persists approved publication intent before push, without raw report data',()=>temporary(async directory=>{
  const config=harness();config.git.publish=vi.fn(async()=>{const files=await readdir(join(directory,'publications'));const text=await readFile(join(directory,'publications',files[0]!), 'utf8');expect(text).not.toContain(claim.task);expect(JSON.parse(text)).toMatchObject({phase:'publishing',commitSha:'b'.repeat(40),releaseNote:'Saving works again.'});});
  expect((await runLocalFeedbackPoll({directory,config,reconcile:async()=> 'pending'})).kind).toBe('implemented');
  const files=await readdir(join(directory,'publications'));expect(JSON.parse(await readFile(join(directory,'publications',files[0]!), 'utf8')).phase).toBe('completed');expect((await stat(join(directory,'health.json'))).mode&0o777).toBe(0o600);
 }));
 it('reconciles a pushed candidate after failed acknowledgement without rerunning a model',()=>temporary(async directory=>{
  const config=harness();config.queue.finish=vi.fn(async()=>false);
  expect((await runLocalFeedbackPoll({directory,config,reconcile:async()=> 'pending'})).kind).toBe('lost_lease');
  const recovered:FeedbackPublicationRecord[]=[];const next=harness();next.queue.claimNext=vi.fn(async()=>null);
  expect((await runLocalFeedbackPoll({directory,config:next,reconcile:async record=>{recovered.push(record);return 'implemented';}})).kind).toBe('empty');
  expect(recovered[0]).toMatchObject({runId:claim.runId,fence:claim.fence,commitSha:'b'.repeat(40)});expect(next.codex.implement).not.toHaveBeenCalled();
 }));
 it('preserves an ambiguous push and its fence instead of recording a false failure',()=>temporary(async directory=>{
  const config=harness();config.git.publish=async()=>{throw new Error('connection lost after push');};
  expect((await runLocalFeedbackPoll({directory,config,reconcile:async()=> 'pending'})).kind).toBe('lost_lease');expect(config.queue.finish).not.toHaveBeenCalled();
  const next=harness();expect((await runLocalFeedbackPoll({directory,config:next,reconcile:async()=> 'pending'})).kind).toBe('reconciliation_pending');expect(next.queue.claimNext).not.toHaveBeenCalled();
 }));
 it('recovers a dead parent lock without rerunning old work',()=>temporary(async directory=>{
  await writeFile(join(directory,'poll.lock'),JSON.stringify({pid:2147483647,owner:'dead-parent'}));
  const config=harness();config.queue.claimNext=vi.fn(async()=>null);
  expect((await runLocalFeedbackPoll({directory,config,reconcile:async()=> 'pending'})).kind).toBe('empty');
  expect(config.codex.implement).not.toHaveBeenCalled();
 }));
 it('runs no model for an empty queue and serializes concurrent polls',()=>temporary(async directory=>{
  const config=harness();let unblock!:()=>void;config.queue.claimNext=async()=>{await new Promise<void>(resolve=>{unblock=resolve;});return null;};
  const running=runLocalFeedbackPoll({directory,config,reconcile:async()=> 'pending'});while(!unblock)await new Promise(resolve=>setTimeout(resolve,5));
  expect((await runLocalFeedbackPoll({directory,config:harness(),reconcile:async()=> 'pending'})).kind).toBe('busy');unblock();expect((await running).kind).toBe('empty');expect(config.codex.implement).not.toHaveBeenCalled();
 }));
});
