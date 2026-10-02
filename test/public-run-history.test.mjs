import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPublicAgent, renderPublicRun } from '../public/public-agent.js';

const at = '2026-10-02T12:00:00.000Z';
const run = () => ({ version:1,status:'completed',startedAt:at,finishedAt:at,omittedEvents:0,events:[{type:'stage',role:'Researcher',status:'completed',at,finishedAt:at},{type:'tool',tool:'read_source',status:'completed',at,finishedAt:at,source:'https://eips.ethereum.org/EIPS/eip-7702'}],charge:{settledWei:'1000000001',settledMicroUsd:42,pendingMicroUsd:1000000,settledCalls:1,totalCalls:2} });
test('public run renders exact settled ETH, valuation and held reserve with bounded snapshot wording', () => {
  const html=renderPublicRun(run(),'zkapi');
  assert.match(html,/0\.000000001000000001 ETH/);assert.match(html,/\$0\.000042/);assert.match(html,/\$1\.000000/);assert.match(html,/Reserved budget is not spent/);assert.match(html,/1 call awaiting settlement/);assert.match(html,/Owner-shared snapshot/);assert.match(html,/https:\/\/eips.ethereum.org\/EIPS\/eip-7702/);
  assert.match(renderPublicRun({...run(),charge:null},'zkapi'),/not a zero-cost claim/);
  assert.match(renderPublicRun(run(),'demo'),/Simulated run/);assert.doesNotMatch(renderPublicRun(run(),'demo'),/ETH|\$1/);
});
test('malformed metadata cannot render scripts, arbitrary roles, tokenized links or hidden private fields', () => {
  const value=run();value.prompt='SECRET_PROMPT';value.events[0].reasoning='SECRET_REASONING';value.events[1].arguments={secret:'SECRET_ARGUMENT'};
  for(const source of ['javascript:alert(1)','https://example.com/?token=SECRET_TOKEN','https://user:pass@example.com/','https://example.com/#secret','https://127.0.0.1/','https://example.com/" onerror="alert(1)']){value.events[1].source=source;const html=renderPublicRun(value,'zkapi');assert.doesNotMatch(html,/SECRET_|javascript:|onerror|href=/);}
  assert.throws(()=>renderPublicRun({...value,events:[{...value.events[0],role:'<script>alert(1)</script>'}]},'zkapi'),/verified/);
  assert.throws(()=>renderPublicRun({...value,charge:{...value.charge,settledWei:'<script>x</script>'}},'zkapi'),/verified/);
  assert.throws(()=>renderPublicRun({...value,events:Array.from({length:65},()=>value.events[0])},'zkapi'),/verified/);
});
test('old results-only public pages do not gain a run history panel', () => {
  const page={slug:'example',title:'Shared result',description:'Owner selected.',updatedAt:at,artifacts:[{id:'artifact',title:'Result 1',content:'A finding.',at,mode:'zkapi'}]};
  assert.doesNotMatch(renderPublicAgent({page},'example'),/Run history/);
  page.artifacts[0].run=run();assert.match(renderPublicAgent({page},'example'),/Run history/);
});
test('settled public runs hide empty budgets and keep exact payment details expandable', () => {
  const value=run();value.charge.pendingMicroUsd=0;value.charge.settledCalls=2;
  const html=renderPublicRun(value,'zkapi');
  assert.doesNotMatch(html,/Reserved budget|awaiting settlement|2 of 2|\$0\.000000/);
  assert.match(html,/<details class="public-run-payment"><summary>Payment details<\/summary>/);
  assert.match(html,/Inference only; excludes funding and network gas/);
});
