import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {encodeFunctionData} from 'viem';
import {TREASURY_RUNWAY_ABI} from '../src/runway.mjs';
import {checkedRunway, checkedFunding, canRetireUnsigned, ethToWei, noteExpiryView, RunwayWalletClient, mountRunwayPanel} from '../public/runway-panel.js';
import {createApp} from '../src/server.mjs';
const OWNER='0x0000000000000000000000000000000000000001',TREASURY='0x0000000000000000000000000000000000000002',DAEMON='0x0000000000000000000000000000000000000003',OTHER='0x0000000000000000000000000000000000000004',HASH='0x'+'a'.repeat(64),EXPENSE='0x'+'b'.repeat(64),NOW=1790860000000;
const project={id:randomUUID(),mainnet:{treasury:TREASURY}};
function storage(){const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)};}
function snapshot(operator=OWNER){const item={id:randomUUID(),status:'prepared',fundingAddress:DAEMON,expenseId:EXPENSE,amountWei:'1000000000000000',calls:[]};item.calls=[{chainId:'0x1',from:OWNER,to:TREASURY,value:'0x0',data:encodeFunctionData({abi:TREASURY_RUNWAY_ABI,functionName:'setRecipient',args:[DAEMON,true]})},{chainId:'0x1',from:operator,to:TREASURY,value:'0x0',data:encodeFunctionData({abi:TREASURY_RUNWAY_ABI,functionName:'pay',args:[EXPENSE,DAEMON,BigInt(item.amountWei)]})}];return{chainId:1,persistence:'healthy',policy:{projectId:project.id,owner:OWNER,operator,treasury:TREASURY,depositGwei:'1000000',lowWaterGwei:'0',maxTopUpWei:'2000000000000000',dailyTopUpWei:'4000000000000000'},refills:[item]};}
function funding(){return{chainId:1,persistence:'healthy',approvalEnabled:true,intents:[],operations:[{id:randomUUID(),status:'quoted',approvalAttempted:false,approvalDigest:'c'.repeat(64),address:DAEMON,request:{kind:'withdrawal',destination:TREASURY,noteId:1},quote:{id:'d'.repeat(64),chain_id:1,destination:TREASURY,amount:1000000,expires_at:NOW+30000,required_fee_wei:'100',fee_reserve_wei:'150',recommended_top_up_wei:'150'}}]};}
class Element{innerHTML='';isConnected=true;handlers=new Map();addEventListener(n,f){this.handlers.set(n,f)}removeEventListener(n,f){if(this.handlers.get(n)===f)this.handlers.delete(n)}contains(n){return n?.owned!==false}fire(n,target){this.handlers.get(n)?.({target,preventDefault(){},stopPropagation(){}})}}
const control=(action,extra={})=>{const n={dataset:{runway:action,...extra},disabled:false,closest:s=>s==='[data-runway]'?n:null};return n;};
test('expiry display fails closed for unknown evidence and ages a cached healthy note into a stop',()=>{
  const note={status:'healthy',canInfer:true,source:'finalized-vault-with-authenticated-daemon-note',expiresAt:Math.floor(NOW/1000)+864000};
  assert.equal(noteExpiryView(note,NOW).status,'healthy');
  assert.equal(noteExpiryView(note,NOW+4*86400000).status,'warning');
  assert.equal(noteExpiryView(note,NOW+8*86400000).status,'blocked');
  assert.equal(noteExpiryView(note,NOW+11*86400000).status,'expired');
  for(const invalid of [null,{}, {...note,source:'daemon-only'}, {...note,expiresAt:'tomorrow'}, {...note,expiresAt:Infinity}, {...note,canInfer:undefined}]) assert.equal(noteExpiryView(invalid,NOW).canInfer,false);
  assert.equal(noteExpiryView({...note,canInfer:false},NOW).status,'blocked');
  assert.equal(noteExpiryView({status:'no_note'},NOW).status,'no_note');
});
async function settled(p){for(let i=0;i<100;i++){if(!p.isBusy())return;await new Promise(r=>setImmediate(r));}throw Error('Still busy');}
function fixture(overrides={}){let sends=0;const saved=storage(),s=snapshot();const client={transactionsEnabled:true,capabilities:async()=>({transactionsEnabled:true}),busy:false,storage:saved,wallet:{ensure:async a=>a,send:async()=>{sends++;return HASH;}}};const api=async(path,body)=>({id:body.refillId,status:'funded',transactionHash:body.transactionHash});return{s,client,saved,api,sends:()=>sends,...overrides};}
test('ETH conversion stays exact and rejects exponents, negative or excess precision',()=>{assert.equal(ethToWei('0.000000000000000001'),'1');assert.equal(ethToWei('1.234567890123456789'),'1234567890123456789');for(const s of ['1e3','-1','01','0.0000000000000000001'])assert.throws(()=>ethToWei(s));});
test('runway validates exact treasury calldata, recipient, amount, chain and project ownership',()=>{const s=snapshot();assert.equal(checkedRunway(s,project,OWNER),s);for(const mutate of [v=>v.policy.owner=OTHER,v=>v.policy.projectId=randomUUID(),v=>v.refills[0].calls[1].to=OTHER,v=>v.refills[0].calls[1].value='0x1',v=>v.refills[0].amountWei='1',v=>v.refills[0].fundingAddress=OTHER,v=>v.refills[0].calls[0].chainId='0x89']){const changed=structuredClone(s);mutate(changed);assert.throws(()=>checkedRunway(changed,project,OWNER));}});
test('wallet payment needs both enablement and exact review before any send',async()=>{const f=fixture(),w=new RunwayWalletClient({project,owner:OWNER,...f});for(const opts of [{enabled:false,reviewed:true},{enabled:true,reviewed:false}])await assert.rejects(w.send(f.s,f.s.refills[0].id,opts));f.client.transactionsEnabled=false;await assert.rejects(w.send(f.s,f.s.refills[0].id,{enabled:true,reviewed:true}));assert.equal(f.sends(),0);});
test('operator mismatch cannot borrow the owner account to pay',async()=>{const f=fixture(),w=new RunwayWalletClient({project,owner:OWNER,...f});await assert.rejects(w.send(snapshot(OTHER),f.s.refills[0].id,{enabled:true,reviewed:true}));const s=snapshot(OTHER);await assert.rejects(w.send(s,s.refills[0].id,{enabled:true,reviewed:true}),/operator must sign/);assert.equal(f.sends(),0);});
test('lost receipt confirmation preserves hash and blocks a second payment across reloads',async()=>{const f=fixture(),api=async()=>{throw Error('Not finalized');},w=new RunwayWalletClient({project,owner:OWNER,...f,api});const id=f.s.refills[0].id,result=await w.send(f.s,id,{enabled:true,reviewed:true});assert.equal(result.transactionHash,HASH);assert.equal(w.pending()[0].transactionHash,HASH);const reloaded=new RunwayWalletClient({project,owner:OWNER,...f,api});await assert.rejects(reloaded.send(f.s,id,{enabled:true,reviewed:true}),/pending/);assert.equal(f.sends(),1);});
test('unknown wallet submission never retries, while an explicit wallet rejection can be reviewed again',async()=>{for(const rejection of [false,true]){const f=fixture();f.client.wallet.send=async()=>{const e=Error('Wallet interrupted');if(rejection)e.code=4001;throw e;};const w=new RunwayWalletClient({project,owner:OWNER,...f});await assert.rejects(w.send(f.s,f.s.refills[0].id,{enabled:true,reviewed:true}));assert.equal(w.pending().length,rejection?0:1);}});
test('finalized confirmation must match exact refill and hash before clearing browser recovery',async()=>{const f=fixture(),w=new RunwayWalletClient({project,owner:OWNER,...f});w.save([{refillId:f.s.refills[0].id,transactionHash:HASH}]);w.api=async()=>({id:randomUUID(),status:'funded',transactionHash:HASH});await assert.rejects(w.confirm(f.s.refills[0].id,HASH));assert.equal(w.pending().length,1);w.api=f.api;await w.confirm(f.s.refills[0].id,HASH);assert.equal(w.pending().length,0);});
test('backend quotes cannot redirect recovery to unrelated destinations',()=>{const f=funding();checkedFunding(f,OWNER,project);f.operations[0].request.destination=OTHER;assert.throws(()=>checkedFunding(f,OWNER,project));});
test('local panel never calls private funding endpoints',async()=>{const e=new Element();let called=false;const p=mountRunwayPanel(e,{project,api:async()=>{called=true;}});await p.ready;assert.equal(called,false);assert.match(e.innerHTML,/Local development ETH/);p.destroy();assert.equal(e.handlers.size,0);});
test('opening Treasury directly verifies its own permission gate without requiring a prior Market visit',async()=>{
 const e=new Element(),f=fixture(),calls=[];f.client.transactionsEnabled=false;
 f.client.capabilities=async id=>{calls.push(id);return{transactionsEnabled:true};};
 const p=mountRunwayPanel(e,{project,owner:OWNER,hosted:true,client:f.client,capabilities:{transactionsEnabled:true},api:async path=>path.endsWith('/runway')?f.s:funding(),now:()=>NOW});
 await p.ready;assert.deepEqual(calls,[project.id]);assert.equal(f.client.transactionsEnabled,true);assert.equal(f.sends(),0);
 f.client.capabilities=async()=>{throw Error('provider-private-detail');};await p.refresh();
 assert.equal(f.client.transactionsEnabled,false);assert.match(e.innerHTML,/Wallet permissions could not be refreshed/);assert.doesNotMatch(e.innerHTML,/provider-private-detail/);p.destroy();
});
test('a late Treasury capability read cannot enable another view after navigation',async()=>{
 const e=new Element(),f=fixture();let finish;f.client.transactionsEnabled=false;f.client.capabilities=()=>new Promise(resolve=>{finish=resolve;});
 const p=mountRunwayPanel(e,{project,owner:OWNER,hosted:true,client:f.client,capabilities:{transactionsEnabled:true},api:async path=>path.endsWith('/runway')?f.s:funding(),now:()=>NOW});
 await new Promise(resolve=>setImmediate(resolve));p.destroy();e.innerHTML='Another view';finish({transactionsEnabled:true});await p.ready;
 assert.equal(f.client.transactionsEnabled,false);assert.equal(e.innerHTML,'Another view');
});
test('automatic refill and expiry closure require independent owner opt-ins and all capabilities',async()=>{
 for(const [available,automatic,close,expectedCalls] of [[false,true,true,0],[true,false,true,1],[true,true,false,1],[true,true,true,1]]) {
  const e=new Element(),f=fixture(),s=f.s,calls=[];s.refills=[];s.capabilities={automaticAvailable:available,operator:OWNER};
  const api=async(path,body)=>{if(path.endsWith('/configure')){calls.push(body);return s;}return path.endsWith('/runway')?s:funding();};
  const p=mountRunwayPanel(e,{project,owner:OWNER,hosted:true,client:f.client,capabilities:{transactionsEnabled:true},api,now:()=>NOW});await p.ready;
  if(!available)assert.match(e.innerHTML,/name="automatic"[^>]*disabled/);
  const form={dataset:{runwayForm:'configure'},elements:{depositEth:{value:'0.001'},lowWaterEth:{value:'0'},maxTopUpEth:{value:'0.002'},dailyTopUpEth:{value:'0.004'},automatic:{checked:automatic},closeBeforeExpiry:{checked:close}},closest:selector=>selector==='[data-runway-form]'?form:null};
  e.fire('submit',form);await settled(p);assert.equal(calls.length,expectedCalls);if(calls.length){assert.equal(calls[0].automatic,automatic);assert.equal(calls[0].closeBeforeExpiry,automatic&&close);}p.destroy();
 }
});
test('pause remains usable during a stalled funding read and overrides a stale automatic snapshot',async()=>{
 const e=new Element(),f=fixture(),s=f.s;s.policy.automatic=true;s.scheduling={automatic:true};s.capabilities={automaticAvailable:true,operator:OWNER};let release,pauses=0;const stalled=new Promise(r=>release=r);
 const api=async path=>{if(path.endsWith('/pause')){pauses++;return{automatic:false};}await stalled;return path.endsWith('/runway')?s:funding();};
 const p=mountRunwayPanel(e,{project,owner:OWNER,hosted:true,client:f.client,capabilities:{transactionsEnabled:true},api,now:()=>NOW});
 assert.match(e.innerHTML,/data-runway="pause-automatic"\s*>/);e.fire('click',control('pause-automatic'));await new Promise(r=>setImmediate(r));assert.equal(pauses,1);assert.match(e.innerHTML,/New automatic authorizations are paused/);
 release();await p.ready;const checkbox=e.innerHTML.match(/<input[^>]+name="automatic"[^>]*>/)[0];assert.doesNotMatch(checkbox,/checked/);p.destroy();
});
test('daemon approval is gated, binds exact quote and blocks unknown approval even after remount',async()=>{for(const enabled of [false,true]){const e=new Element(),f=fixture(),fund=funding(),item=fund.operations[0];let approved=0;const api=async(path,body)=>{if(path.endsWith('/operation-approve')){approved++;assert.deepEqual(body,{intentId:item.id,quoteId:item.quote.id,approvalDigest:item.approvalDigest});throw Error('Response lost');}return path.endsWith('/runway')?f.s:fund;};const opts={project,owner:OWNER,hosted:true,api,client:f.client,capabilities:{transactionsEnabled:enabled},now:()=>NOW};const p=mountRunwayPanel(e,opts);await p.ready;e.fire('click',control('review-operation',{intent:item.id}));await settled(p);e.fire('change',{checked:true,matches:s=>s==='[data-runway-review]'});e.fire('click',control('execute'));await settled(p);assert.equal(approved,enabled?1:0);p.destroy();if(enabled){const p2=mountRunwayPanel(e,opts);await p2.ready;assert.match(e.innerHTML,/Approval outcome is unknown/);e.fire('click',control('review-operation',{intent:item.id}));await settled(p2);e.fire('change',{checked:true,matches:s=>s==='[data-runway-review]'});e.fire('click',control('execute'));await settled(p2);assert.equal(approved,1);p2.destroy();}}});
test('destroyed panel ignores late project snapshots and removes listeners',async()=>{const e=new Element();let release;const promise=new Promise(r=>release=r),f=fixture();const p=mountRunwayPanel(e,{project,owner:OWNER,hosted:true,client:f.client,api:async path=>{await promise;return path.endsWith('/runway')?f.s:funding();}});p.destroy();e.innerHTML='Another project';release();await p.ready;assert.equal(e.innerHTML,'Another project');assert.equal(e.handlers.size,0);});
test('fresh local server serves runway assets with self-only stylesheet policy',async t=>{const app=createApp({});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));for(const path of ['/runway-panel.js','/runway-panel.css']){const r=await fetch(`http://127.0.0.1:${app.address().port}${path}`);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/style-src 'self'/);}const html=await(await fetch(`http://127.0.0.1:${app.address().port}/app`)).text();assert.match(html,/href="\/runway-panel.css"/);});

test('only a failed unsigned preparation offers retirement and requires explicit review without enabling signing',async()=>{
 const e=new Element(),f=fixture(),s=f.s,item={id:randomUUID(),status:'prepare_unknown'},fund=funding();s.refills=[item];fund.intents=[{id:randomUUID(),idempotencyKey:'runway-'+item.id,status:'quote_unknown',approvalAttempted:false}];
 assert.equal(canRetireUnsigned(item,fund),true);
 for(const patch of [{status:'prepared'},{transactionHash:HASH},{expenseId:EXPENSE},{calls:[{}]},{confirmationBlock:'1'},{kind:'recovery-fee'}])assert.equal(canRetireUnsigned({...item,...patch},fund),false);
 assert.equal(canRetireUnsigned(item,{...fund,intents:[{...fund.intents[0],approvalAttempted:true}]}),false);
 let retired=0;const api=async(path,body)=>{if(path.endsWith('/abandon-unsigned')){retired++;assert.deepEqual(body,{refillId:item.id});item.status='abandoned';return item;}return path.endsWith('/runway')?s:fund;};
 const p=mountRunwayPanel(e,{project,owner:OWNER,hosted:true,client:f.client,capabilities:{transactionsEnabled:false},api,now:()=>NOW});await p.ready;
 assert.match(e.innerHTML,/Retire unsigned preparation/);e.fire('click',control('retire-refill',{refill:item.id}));await settled(p);
 e.fire('click',control('execute'));await settled(p);assert.equal(retired,0);
 e.fire('change',{checked:true,matches:s=>s==='[data-runway-review]'});e.fire('click',control('execute'));await settled(p);assert.equal(retired,1);assert.equal(f.sends(),0);assert.match(e.innerHTML,/history is preserved/);p.destroy();
});
