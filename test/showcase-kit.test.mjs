import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kit } from '../src/kit.mjs';
import { Store } from '../src/store.mjs';
import { AgentTools } from '../src/agent-tools.mjs';
import { ShowcaseDirectory } from '../src/experience.mjs';
import { fixtureCharge } from './fixtures/charge-accounting.mjs';

test('actual Kit autonomous result links saved-plan source actions and settled call accounting to its public snapshot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-showcase-kit-')); t.after(() => rmSync(dir, { recursive:true,force:true }));
  const owner = '0x1111111111111111111111111111111111111111', source = 'https://eips.ethereum.org/EIPS/eip-7702', at = new Date(1800000000 * 1000), receipts = new Map(); let calls = 0;
  const provider = { mode:'zkapi', models:async()=>[{id:'fixture/model',oa_request_limit_micro_usd:500000,oa_accounting_margin_micro_usd:1000}], accountingIdentity:async()=>({version:1,journal_id:'a'.repeat(32)}),callSettlement:async id=>receipts.get(id),complete:async(body, accounting)=>{
    calls++; const identity=calls.toString(16).padStart(64,'0');receipts.set(accounting.callId,fixtureCharge({callId:accounting.callId,session:identity,receipt:identity}).report);
    return { answer:calls===1?JSON.stringify({question:'Which account changes are documented?',sourceUrls:[source]}):`## Findings\nA saved finding with [its source](${source}).`,verification:'offline-provider-fixture' };
  } };
  const file=join(dir,'kit.json'),store=new Store(file,'zkapi');
  const kit=new Kit({store,provider,chain:{},now:()=>at,agentTools:new AgentTools({client:{},sourceReader:async url=>({url,text:'PRIVATE RAW SOURCE EXCERPT',fetchedAt:at.toISOString()})})});
  const p=kit.create({requestKey:randomUUID(),name:'Sharing fixture',symbol:'SHARE',purpose:'PRIVATE PURPOSE',template:'research',swarm:false,model:'fixture/model',total:5000000,daily:5000000,request:1000000});
  kit.note(p.id,'PRIVATE SAVED NOTE');
  kit.autonomy.configure(p.id,{enabled:true,objective:'Research documented account changes.',cadenceMinutes:1440,dailyRunCap:1,allowedTools:['read_source'],sourceUrls:[source],sourceHosts:[],reviewerModel:null});
  await kit.autonomy.run(p.id,{requestKey:randomUUID()}); const cycle=p.autonomy.cycles.at(-1);
  for(let i=0;i<8;i++){if(kit.execution)await kit.execution;if(['completed','blocked','interrupted'].includes(cycle.status))break;await kit.autonomy.advance(p,cycle);}
  assert.equal(cycle.status,'completed',cycle.error || JSON.stringify({planner:cycle.planner,research:cycle.research,review:cycle.review}));assert.equal(calls,2);
  const restored=new Store(file,'zkapi'),saved=restored.data.projects[0],job=restored.data.jobs.find(j=>j.autonomy?.phase==='research'),artifact=saved.artifacts.find(a=>a.id===job.artifactId);
  assert.equal(job.steps[0].toolActivity[0].initiatedBy,'saved-plan');assert.equal(job.steps[0].toolActivity[0].result.source,source);
  const service=new ShowcaseDirectory({file:join(dir,'public.sealed.json'),key:Buffer.alloc(32,49),now:()=>at,projectForOwner:(who,id)=>{assert.equal(who,owner);assert.equal(id,p.id);return saved;},jobsForOwnerProject:(who,id)=>{assert.equal(who,owner);return restored.data.jobs.filter(j=>j.projectId===id);}});
  const input={projectId:p.id,title:'Selected research',description:'One completed source-based result.',artifactIds:[artifact.id],includeRunHistory:true},preview=service.preview(owner,input);
  const run=preview.preview.artifacts[0].run;
  assert.equal(run.events.find(e=>e.type==='tool').source,source);assert.equal(run.charge.settledWei,'10000000000000');assert.equal(run.charge.pendingMicroUsd,0);assert.equal(run.charge.settledCalls,1);
  const page=service.publish(owner,{...input,previewDigest:preview.previewDigest}).showcase,publicText=JSON.stringify(service.public(page.slug));
  for(const hidden of ['PRIVATE',owner,p.id,job.id,'question planning','requestHash','billing_quote','journal_id'])assert.equal(publicText.includes(hidden),false,hidden);
  assert.equal(service.public(page.slug).page.artifacts[0].content,artifact.content);
});
