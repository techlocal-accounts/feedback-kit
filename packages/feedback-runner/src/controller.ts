import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,open,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {isAbsolute,join,parse,resolve} from 'node:path';
import {homedir} from 'node:os';
import {pollFeedbackOnce,type FencedClaim,type LocalFeedbackRunnerConfig,type PollResult} from './index.js';

export interface FeedbackPublicationRecord {
  schemaVersion:1;reportId:string;runId:string;fence:string;commitSha:string;baseSha:string;
  changedPaths:string[];releaseNote:string;phase:'publishing'|'published'|'completed'|'needs_review';updatedAt:string;
}
export type FeedbackReconciliation = 'implemented'|'needs_review'|'pending';

async function privateDirectory(path:string){
  await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid()))throw new Error('Unsafe feedback state directory');
  await chmod(path,0o700);
}
async function atomicJson(path:string,value:unknown){const temporary=`${path}.${randomUUID()}.tmp`;try{await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}}
function parseRecord(value:unknown):FeedbackPublicationRecord{
  const v=value as FeedbackPublicationRecord;
  if(!v||v.schemaVersion!==1||!['publishing','published','completed','needs_review'].includes(v.phase)||
    ![v.reportId,v.runId,v.fence].every(x=>typeof x==='string'&&x.length>0&&x.length<=200)||
    ![v.commitSha,v.baseSha].every(x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x))||
    typeof v.releaseNote!=='string'||!v.releaseNote.trim()||v.releaseNote.length>1000||
    !Array.isArray(v.changedPaths)||v.changedPaths.length>500||!v.changedPaths.every(x=>typeof x==='string'&&x.length<500)||
    !Number.isFinite(Date.parse(v.updatedAt)))throw new Error('Invalid feedback publication journal');
  return v;
}
/** One local poll, with private intent-before-push recovery. Reconciliation belongs to the app's fenced storage adapter. */
export async function runLocalFeedbackPoll(input:{
  directory:string;config:LocalFeedbackRunnerConfig;
  reconcile(record:FeedbackPublicationRecord):Promise<FeedbackReconciliation>;
}):Promise<PollResult|{kind:'busy'|'reconciliation_pending'}>{
  const directory=resolve(input.directory);
  if(!isAbsolute(input.directory)||directory===parse(directory).root||directory===homedir())throw new Error('Feedback state needs a bounded absolute directory');
  await privateDirectory(directory);
  const lock=join(directory,'poll.lock'),owner=randomUUID();
  for(let attempt=0;;attempt++){
    try{const file=await open(lock,'wx',0o600);await file.writeFile(JSON.stringify({pid:process.pid,owner}));await file.close();break;}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const info=await lstat(lock);if(!info.isFile()||info.isSymbolicLink())throw new Error('Unsafe feedback lock');
      let saved:{pid?:number};try{saved=JSON.parse(await readFile(lock,'utf8'));}catch{return {kind:'busy'};}
      if(!Number.isSafeInteger(saved.pid)||saved.pid! < 1)return {kind:'busy'};
      try{process.kill(saved.pid!,0);return {kind:'busy'};}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return {kind:'busy'};}
      if(attempt)throw new Error('Could not recover feedback poll lock');
      const recovery=join(directory,'recovery.lock');let held=false;
      try{
        const guard=await open(recovery,'wx',0o600);held=true;await guard.close();
        const current=JSON.parse(await readFile(lock,'utf8'));
        if(current.pid!==saved.pid)return {kind:'busy'};
        try{process.kill(current.pid,0);return {kind:'busy'};}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return {kind:'busy'};}
        await rm(lock);
      }catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return {kind:'busy'};throw e;}
      finally{if(held)await rm(recovery,{force:true});}
    }
  }
  const health=(state:string,extra:Record<string,unknown>={})=>atomicJson(join(directory,'health.json'),{schemaVersion:1,state,lastSeenAt:new Date().toISOString(),pid:process.pid,...extra});
  try{
    const publications=join(directory,'publications');await privateDirectory(publications);
    await health('checking');
    const files=(await readdir(publications)).filter(name=>name.endsWith('.json'));
    if(files.length>1000)throw new Error('Feedback journal inspection exceeds its bound');
    for(const name of files){
      if(!/^[A-Za-z0-9_-]{1,100}\.json$/.test(name))throw new Error('Unsafe feedback journal name');
      const path=join(publications,name),info=await lstat(path);
      if(!info.isFile()||info.isSymbolicLink()||info.size>100_000)throw new Error('Unsafe feedback journal file');
      const record=parseRecord(JSON.parse(await readFile(path,'utf8')));
      if(record.phase==='completed'||record.phase==='needs_review')continue;
      const result=await input.reconcile(record);
      if(result==='pending'){await health('blocked',{reason:'publication_reconciliation',reportId:record.reportId});return {kind:'reconciliation_pending'};}
      await atomicJson(path,{...record,phase:result==='implemented'?'completed':'needs_review',updatedAt:new Date().toISOString()});
    }
    const base=input.config;let claim:FencedClaim|undefined;
    let review:{approved:boolean;releaseNote?:string}|undefined;
    let pending:FeedbackPublicationRecord|undefined;
    const persist=async(phase:FeedbackPublicationRecord['phase'])=>{
      if(!pending)throw new Error('Missing feedback publication intent');
      pending={...pending,phase,updatedAt:new Date().toISOString()};parseRecord(pending);
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(pending.runId))throw new Error('Invalid feedback run identity');
      await atomicJson(join(publications,`${pending.runId}.json`),pending);
    };
    const config:LocalFeedbackRunnerConfig={...base,
      queue:{
        claimNext:async()=>{const next=await base.queue.claimNext();claim=next??undefined;if(next)await health('working',{reportId:next.reportId,runId:next.runId});return next;},
        renew:c=>base.queue.renew(c),owns:c=>base.queue.owns(c),markAvailable:(...args)=>base.queue.markAvailable(...args),
        finish:async(c,outcome)=>{
          if(pending&&outcome.status!=='implemented')return false;
          const result=await base.queue.finish(c,outcome);if(result&&pending)await persist('completed');return result;
        },
      },
      codex:{implement:args=>base.codex.implement(args),review:async args=>{const result=await base.codex.review(args);review=result;return result;}},
      git:{createIsolatedCheckout:c=>base.git.createIsolatedCheckout(c),inspect:c=>base.git.inspect(c),snapshot:(...args)=>base.git.snapshot(...args),discard:c=>base.git.discard(c),
        publish:async(checkout,sha,guard)=>{
          if(!claim||!review?.approved||!review.releaseNote?.trim())throw new Error('Publication requires the independent review receipt');
          const candidate=await base.git.inspect(checkout);
          if(candidate.headSha!==sha)throw new Error('Publication candidate changed');
          pending={schemaVersion:1,reportId:claim.reportId,runId:claim.runId,fence:claim.fence,commitSha:sha,baseSha:checkout.baseSha,changedPaths:candidate.changedPaths,releaseNote:review.releaseNote,phase:'publishing',updatedAt:new Date().toISOString()};
          await persist('publishing');await base.git.publish(checkout,sha,guard);await persist('published');
        },
      },
    };
    const result=await pollFeedbackOnce(config);await health('ready',{lastResult:result.kind});return result;
  }catch(error){await health('error',{reason:'poll_failed'}).catch(()=>{});throw error;}
  finally{try{const saved=JSON.parse(await readFile(lock,'utf8'));if(saved.owner===owner)await rm(lock);}catch{/* Never remove another process's lock. */}}
}
