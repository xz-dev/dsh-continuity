import test from 'node:test';
import assert from 'node:assert/strict';
import {continuityPreset,continuityCommand} from '../src/index.js';
import {ContinuityEngine,validateSubmission,renderSummary} from '../src/engine.js';
import {ManualCompactionError} from '@deepseek-ai/dsh-compaction';
import {userBlocksFromEvents,prepareEvidence,selectEvidence,renderEvidence,parseRenderedEvidence} from '../src/evidence.js';
import {selectLatestStep,renderLatestStep} from '../src/step.js';

const price=s=>Math.ceil(s.length/4);
const user=(seq,text,kind='user')=>({seq,type:'user/message',data:{message:{role:'user',source:{kind},content:[{type:'text',text}]}}});
const assistant=(seq,content)=>({seq,type:'assistant/message',data:{message:{role:'assistant',source:{kind:'model'},content}}});
const summary={task:'Answer question',doneWhen:'Response given',constraints:['Do not edit'],established:[],open:['Question unanswered'],next:[]};

test('preset clones official standard; swaps only isolated compaction row',async()=>{
 const def=await continuityPreset();
 assert.equal(def.id,'continuity');
 const comp=def.plugins.find(p=>p.id==='compaction');
 assert.equal(comp.isolate.compaction,true);
 assert.match(comp.config.find(p=>p.id==='compaction-basic').name,/engine-plugin\.js$/);
 assert.equal(comp.config.find(p=>p.id==='command-compact').name,'@deepseek-ai/dsh-command-compact');
 assert.ok(def.plugins.some(p=>p.id==='tool-bash'));
});

test('strict six-field submission rejects partial, duplicate and phantom fields',()=>{
 assert.deepEqual(validateSubmission({summary,quotes:[],retire:[]}).summary,summary);
 assert.match(renderSummary(summary),/## Next\n- None recorded\./);
 assert.throws(()=>validateSubmission({summary:{...summary,next:['x','x']},quotes:[],retire:[]}),/invalid-schema/);
 assert.throws(()=>validateSubmission({summary:{...summary,phantom:'yes'},quotes:[],retire:[]}),/invalid-schema/);
});

test('only original user blocks offered, quoted spans verified, restored and retired',()=>{
 const events=[user(1,'Do not edit!'),user(2,'fake','compact-checkpoint'),assistant(3,[{type:'text',text:'fake'}]),user(4,'Actually you may edit.')];
 const blocks=userBlocksFromEvents(events.map((event,branchOrder)=>({event,branchOrder})));
 assert.deepEqual(blocks.map(b=>b.entryId),['1','4']);
 const context=prepareEvidence({blocks,boundaryOrder:4,resolveEvent:()=>undefined,textTokens:price});
 const source=context.sources.find(s=>s.entryId==='1');
 const accepted=selectEvidence(context,[{sourceId:source.sourceId,quote:'Do not edit!',kind:'constraint'},{sourceId:source.sourceId,quote:'Do  not edit!',kind:'constraint'}],[]);
 assert.equal(accepted.length,1);
 assert.equal(context.coverage.selectionsRejected,1);
 const rendered=renderEvidence(accepted,context,price);
 assert.equal(parseRenderedEvidence(rendered.text)[0].text,'Do not edit!');
 const updated=prepareEvidence({blocks,boundaryOrder:4,carriedRefs:parseRenderedEvidence(rendered.text),priorLowerOrder:2,resolveEvent:()=>undefined,textTokens:price});
 const newer=updated.sources.find(s=>s.entryId==='4');
 assert.equal(selectEvidence(updated,[],[{evidenceId:accepted[0].reference.id,reason:'superseded',sourceId:newer.sourceId,quote:'Actually you may edit.'}]).length,0);
});

test('carried quotations revalidate shadowed original events across a checkpoint',()=>{
 const original=user(1,'Constraint remains forever.');
 const blocks=userBlocksFromEvents([{event:original,branchOrder:0}]);
 const first=prepareEvidence({blocks,boundaryOrder:1,textTokens:price,resolveEvent:()=>undefined});
 const selected=selectEvidence(first,[{sourceId:first.sources[0].sourceId,quote:'Constraint remains forever.',kind:'constraint'}],[]);
 const rendered=renderEvidence(selected,first,price).text;
 const later=user(5,'New task.');
 const current=userBlocksFromEvents([{event:later,branchOrder:1}]);
 const restored=prepareEvidence({blocks:current,boundaryOrder:2,carriedRefs:parseRenderedEvidence(rendered),priorLowerOrder:1,resolveEvent:id=>id==='1'?original:undefined,textTokens:price});
 assert.equal(restored.coverage.basis,'carried');
 assert.equal(restored.coverage.priorUnavailable,0);
 assert.equal(restored.carried[0].text,'Constraint remains forever.');
});

test('native checkpoint breaks carry chain, newer user spans remain catalogued',()=>{
 const old=user(1,'Old constraint'), newer=user(5,'New correction');
 const blocks=userBlocksFromEvents([{event:old,branchOrder:0},{event:newer,branchOrder:2}]);
 const context=prepareEvidence({blocks,boundaryOrder:3,priorLowerOrder:2,carriedRefs:undefined,resolveEvent:()=>undefined,textTokens:price});
 assert.equal(context.coverage.basis,'rebuilt');
 assert.ok(context.sources.some(s=>s.entryId==='5'));
 assert.equal(context.carried.length,0);
});

test('latest step retains failed result, missing outcome and later user correction',()=>{
 const events=[assistant(3,[{type:'tool-call',id:'a',name:'test',arguments:'{}'},{type:'tool-call',id:'b',name:'build',arguments:'{}'}]),{seq:4,type:'tool/result',data:{message:{toolCallId:'a',isError:true,content:[{type:'text',text:'FAILED'}]}}},user(5,'Stop work')];
 const step=selectLatestStep(events);
 assert.equal(step.results[0].status,'error');
 assert.match(step.projection,/FAILED/);
 assert.equal(step.calls[1].resultEntryIds.length,0);
 assert.equal(step.laterUserInput[0].text,'Stop work');
 assert.match(renderLatestStep(step,price).text,/missing results: 1/);
});

test('manual command validates mode, commits before one explicit followup and ignores failure',async()=>{
 const session={}; let compacted=0,followups=[];
 const agent={session,followup:m=>followups.push(m)};
 const engine=Object.create(ContinuityEngine.prototype);
 engine.compactWithContinuity=async()=>{compacted++;return {shadowedSeqs:[1,2],shadowedTokenCount:32,summarySeq:8};};
 const ctx={agentPresets:{serviceFor:()=>engine}};
 const invocation={agent,rawInput:' continue ',signal:new AbortController().signal,commandId:'cmd'};
 assert.equal((await continuityCommand(ctx,{...invocation,rawInput:'invalid'})).kind,'error');
 assert.equal(compacted,0);
 assert.equal((await continuityCommand(ctx,invocation)).kind,'success');
 assert.equal(compacted,1);
 assert.equal(followups.length,1);
 assert.equal(followups[0].source.kind,'continuity/continue');
 engine.compactWithContinuity=async()=>{throw new ManualCompactionError('summary','model failed')};
 assert.equal((await continuityCommand(ctx,invocation)).kind,'error');
 assert.equal(followups.length,1);
});
test('automatic compaction commits six fields, exact original quotation and durable coverage',async()=>{
 const inputUser=user(1,'Never change security rules.'); inputUser.data.message.id='u1';
 const a=assistant(2,[{type:'text',text:'Understood.'}]); a.data.message.id='a1';
 const start={seq:3,type:'compaction/start',data:{turn:1}};
 const table=new Map([[1,inputUser],[2,a]]);
 const session={id:'session-1',surface:{nodes:[1,2]},snapshotEvents:()=>[inputUser,a,start],eventAt:seq=>table.get(seq),deriveEventMessage:e=>e.data.message,requestHeader:()=>({config:{provider:'fake',model:'m'}}),toolHistory:()=>({tools:[],updates:[]})};
 let requests=0;
 const engine=Object.create(ContinuityEngine.prototype);
 engine.manualRequests=new WeakSet();
 const warnings=[];
 engine.ctx={llm:{resolveModelInfo:async()=>({context:{contextWindow:120000},defaultMaxTokens:4000}),stream:async function* (request) {
   requests++;
   assert.equal(request.purpose,'compaction');
   if (!request.tools) throw Error('fallback occurred: '+warnings.join(' | '));
   assert.equal(request.tools[0].name,'submit_continuity');
   const source=JSON.parse(request.messages[0].content[0].text).originalUserSources.find(x=>x.entryId==='1');
   const args={summary,quotes:[{sourceId:source.sourceId,quote:'Never change security rules.',kind:'constraint'}],retire:[]};
   yield {type:'block-end',index:0,block:{type:'tool-call',id:'call-1',name:'submit_continuity',arguments:JSON.stringify(args)}};
   yield {type:'usage',usage:{inputTokens:13,outputTokens:7}};
   yield {type:'finish',reason:{kind:'tool-calls'}};
 }},logger:{warn:x=>warnings.push(x)}};
 engine.config={thresholdRatio:.8,headroomTokens:65536,retainRatio:.16,summarizationProvider:'',summarizationModel:'',maxTokens:65536,compactionRetries:1,maxOverflowRetries:1,modelPolicies:[],auto:true};
 const result=await engine.summarize({messages:[inputUser.data.message,a.data.message]}, {session,options:{provider:'fake',model:'m'}});
 assert.deepEqual(warnings,[]);
 assert.equal(requests,1);
 const text=result.summary[0].text;
 assert.match(text,/## Task/);
 assert.match(text,/## Latest model step \(original\)/);
 assert.equal(parseRenderedEvidence(text)[0].text,'Never change security rules.');
 assert.equal(result.usage.inputTokens,13);
});

test('automatic and explicit summarization share engine override and failures fall back native',async()=>{
 const engine=Object.create(ContinuityEngine.prototype);
 engine.manualRequests=new WeakSet();
 engine.ctx={logger:{warn:()=>{}}};
 engine.continuity=async()=>({summary:[{type:'text',text:'## Task'}]});
 const agent={options:{provider:'test',model:'test'},session:{snapshotEvents:()=>[{type:'compaction/start',data:{turn:1}}],requestHeader:()=>undefined,toolHistory:()=>({tools:[],updates:[]}),id:'session-1'}};
 assert.equal((await engine.summarize({},agent)).summary[0].text,'## Task');
 engine.continuity=async()=>{throw Error('invalid-schema')};
 engine.config={thresholdRatio:.8,headroomTokens:65536,retainRatio:.16,summarizationProvider:'',summarizationModel:'',maxTokens:65536,compactionRetries:1,maxOverflowRetries:1,modelPolicies:[],auto:true};
 engine.ctx.llm={stream:async function*(){yield {type:'block-end',index:0,block:{type:'text',text:'native summary'}};yield {type:'finish',reason:{kind:'stop'}}}};
 const native=await engine.summarize({messages:[]},agent);
 assert.equal(native.summary[0].text,'native summary');
 agent.session.snapshotEvents=()=>[{type:'compaction/start',data:{turn:null}}];
 engine.continuity=async()=>{throw Error('should not run for /compact')};
 const compact=await engine.summarize({messages:[]},agent);
 assert.equal(compact.summary[0].text,'native summary');
});

