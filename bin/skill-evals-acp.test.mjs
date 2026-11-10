import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AcpClient,evaluate,nativeCost,parseOptions,prepareNative,authorizeArtifactRead,providerLimited} from './skill-evals-acp.mjs';
import {parseArgs,plan} from './skill-evals.mjs';
const fixture=fileURLToPath(new URL('./skill-evals-acp.fixture.mjs',import.meta.url));
function input(t){
 const root=mkdtempSync(path.join(tmpdir(),'eval-native-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const plugin=path.join(root,'plugin'),cwd=path.join(plugin,'evals','triage--one');
 mkdirSync(path.join(plugin,'skills','triage'),{recursive:true});mkdirSync(path.join(cwd,'resources'),{recursive:true});
 writeFileSync(path.join(plugin,'skills','triage','SKILL.md'),'---\nname: triage\ndescription: Triage failing probes.\n---\nUse journalctl -u probe.service.');
 writeFileSync(path.join(cwd,'case.yaml'),JSON.stringify({name:'triage--one',runs:1,execution:{prompt:'How do I inspect a failing probe?',allowed_tools:['Skill','Read'],max_turns:3,timeout_seconds:10},graders:[{name:'skill-fired',type:'tool_used',input_match:'triage'},{name:'criteria',type:'llm',criteria:'Names journalctl and the unit'}]}));
 return{root,plugin,cwd,file:path.join(root,'results.json')};
}
test('native options and usage keep unknown cost distinct and reject implicit models',()=>{
 assert.throws(()=>parseOptions([]),/explicit --model/);
 assert.equal(parseOptions(['--model','fixture/model']).judgeModel,'fixture/model');
 assert.throws(()=>parseOptions(['--model','x','-j','3']),/Invalid/);
 assert.equal(nativeCost({used:999,size:1000}),null);
 assert.equal(nativeCost({cost:{currency:'credits',amount:1}}),null);
 assert.equal(nativeCost({cost:{currency:'USD',amount:0.2}}),0.2);
 assert.throws(()=>nativeCost({cost:{currency:'USD',amount:-1}}),/Invalid/);
 for(const harness of ['opencode','goose','antigravity','agy'])assert.equal(parseArgs(['--runner',harness]).runner,harness==='agy'?'antigravity':harness);
});
test('native configuration excludes ambient MCP, plugins and inherited secrets',t=>{
 const f=input(t),home=path.join(f.root,'native-home');mkdirSync(home);
 const app=path.join(home,'.gemini','antigravity-cli');mkdirSync(app,{recursive:true});
 for(const harness of ['opencode','goose','antigravity']){
  const root=path.join(f.root,harness);mkdirSync(root);
  const config=prepareNative(harness,root,{HOME:home,PATH:process.env.PATH,UNRELATED_SECRET:'do-not-inherit'});
  assert.equal(config.env.UNRELATED_SECRET,undefined);
  assert.equal(config.env.OPENCODE_CONFIG,undefined);
  if(harness==='antigravity'){
   assert.equal(realpathSync(path.join(root,'gemini','antigravity-cli')),app);
   const settings=path.join(app,config.args[config.args.indexOf('--cli_dir_name')+1]);
   assert.match(readFileSync(path.join(settings,'settings.json'),'utf8'),/write_file\(\*\)/);
   config.cleanup();assert.equal(existsSync(settings),false);assert.ok(existsSync(app));
  }
 }
});
test('real ACP/MCP subprocesses capture responses, bounded skill evidence, usage and independent judgment',async t=>{
 const f=input(t),children=[];
 const client=new AcpClient('opencode',{start:(_command,args,options)=>{const child=spawn(process.execPath,[fixture,...args],options);children.push(child);return child;}});
 const exit = await evaluate('opencode',f.plugin,f.file,parseOptions(['--model','fixture/model','--max-cost-usd','1']),{client});
 assert.equal(exit,0,readFileSync(f.file,'utf8'));
 const result=JSON.parse(readFileSync(f.file));
 assert.equal(result.costUsd,0.02);assert.equal(result.cases[0].aggregates.score,1);
 const trace=readFileSync(result.cases[0].arms.with[0].tracePath,'utf8');
 assert.match(trace,/"tool":"Skill"/);assert.match(trace,/"judge"/);assert.match(trace,/fixture-1/);
 assert.equal(children.length,2);assert.ok(children.every(p=>p.exitCode!==null||p.signalCode!==null));
});
test('shared --case selection changes the planned suite before any harness starts',()=>{
 const p=plan(parseArgs(['--root',fileURLToPath(new URL('../plugins/repo-tools/skills',import.meta.url)),'--skill','skill-evals','--case','skill-evals--coverage-first']));
 assert.equal(p[0].entries.length,1);assert.equal(p[0].entries[0].slug,'coverage-first');
});

test('native spill-file reads require the current session and an exact known MCP result',t=>{
 const f=input(t),step=path.join(f.root,'gemini','antigravity-cli','brain','owned','.system_generated','steps','2');mkdirSync(step,{recursive:true});
 const file=path.join(step,'output.txt'),trace=path.join(f.root,'tools.jsonl');
 writeFileSync(file,'bounded MCP output');writeFileSync(trace,JSON.stringify({type:'tool.call',result:'bounded MCP output'})+'\n');
 const call={kind:'read',rawInput:{Path:file}};
 assert.equal(authorizeArtifactRead(call,f.root,'owned',trace),true);
 assert.equal(authorizeArtifactRead(call,f.root,'foreign',trace),false);
 assert.equal(authorizeArtifactRead({...call,kind:'edit'},f.root,'owned',trace),false);
 writeFileSync(file,'different native or model content');assert.equal(authorizeArtifactRead(call,f.root,'owned',trace),false);
 assert.equal(authorizeArtifactRead({kind:'read',rawInput:{Path:'/etc/passwd'}},f.root,'owned',trace),false);
});

test('partial native permission updates inherit trusted tool identity before a spill read',async t=>{
 const f=input(t),app=path.join(f.root,'auth-app');mkdirSync(app);
 const client=new AcpClient('antigravity',{env:{...process.env,REPO_EVAL_ANTIGRAVITY_AUTH_DIR:app},start:(_command,args,options)=>spawn(process.execPath,[fixture,...args],{...options,env:{...options.env,EVAL_FIXTURE_ARTIFACT:'1'}})});
 const exit=await evaluate('antigravity',f.plugin,f.file,parseOptions(['--model','fixture/model']),{client});
 assert.equal(exit,0,readFileSync(f.file,'utf8'));
 const r=JSON.parse(readFileSync(f.file));assert.match(readFileSync(r.cases[0].arms.with[0].tracePath,'utf8'),/native.artifact.read/);
});

test('reusing an output directory cannot reuse old skill loads or exhausted tool limits',async t=>{
 const f=input(t);let skip=false;
 const client=new AcpClient('opencode',{start:(_command,args,options)=>spawn(process.execPath,[fixture,...args],{...options,env:{...options.env,EVAL_FIXTURE_SKIP_SKILL:skip?'1':'0'}})});
 const options=parseOptions(['--model','fixture/model']);
 assert.equal(await evaluate('opencode',f.plugin,f.file,options,{client}),0);
 const first=JSON.parse(readFileSync(f.file));const trace=first.cases[0].arms.with[0].tracePath;
 skip=true;
 assert.equal(await evaluate('opencode',f.plugin,f.file,options,{client}),1,'the new run never loads the skill');
 const second=JSON.parse(readFileSync(f.file));
 assert.equal(second.partial,false);assert.equal(second.cases[0].arms.with[0].graders.find(x=>x.name==='skill-fired').passed,false);
 appendFileSync(`${trace}.native.jsonl.tools`,JSON.stringify({type:'limit.exceeded'})+'\n');
 appendFileSync(`${trace}.native.jsonl`,JSON.stringify({event:'prior-run'})+'\n');
 assert.equal(await evaluate('opencode',f.plugin,f.file,options,{client}),1,'old limits must not abort a new invocation');
 assert.doesNotMatch(readFileSync(`${trace}.native.jsonl`,'utf8'),/prior-run/);
});
test('REPO_SKILL_EVALS_MODEL selects the model for unattended callers; an explicit --model still wins',()=>{
 assert.throws(()=>parseOptions([],{}),/explicit --model or REPO_SKILL_EVALS_MODEL/);
 assert.equal(parseOptions([],{REPO_SKILL_EVALS_MODEL:'env/model'}).model,'env/model');
 assert.equal(parseOptions([],{REPO_SKILL_EVALS_MODEL:'env/model'}).judgeModel,'env/model');
 assert.equal(parseOptions(['--model','flag/model'],{REPO_SKILL_EVALS_MODEL:'env/model'}).model,'flag/model');
});
test('provider quota stops are classified without exposing native diagnostics',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'eval-native-limit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const log=path.join(root,'native.log');
 assert.equal(providerLimited(Error('RESOURCE_EXHAUSTED'),log),true);
 assert.equal(providerLimited({message:'Internal error',data:{details:'usage_limit_reached'}},log),true);
 assert.equal(providerLimited(Error('Eval tool-call limit exceeded'),log),false);
 writeFileSync(log,'planning the quota of tool calls\n');
 assert.equal(providerLimited(Error('Internal error'),log),false);
 writeFileSync(log,'error: code=RESOURCE_EXHAUSTED\n');
 assert.equal(providerLimited(Error('Internal error'),log),true);
});
test('a native quota stop settles the run partial with the provider-limit reason',async t=>{
 const f=input(t);
 const client=new AcpClient('opencode',{start:(_command,args,options)=>spawn(process.execPath,[fixture,...args],{...options,env:{...options.env,EVAL_FIXTURE_QUOTA:'1'}})});
 const exit=await evaluate('opencode',f.plugin,f.file,parseOptions(['--model','fixture/model']),{client});
 const result=JSON.parse(readFileSync(f.file,'utf8'));
 assert.equal(exit,2);assert.equal(result.partial,true);assert.equal(result.partialReason,'provider-limit');
 assert.doesNotMatch(result.cases[0].arms.with[0].error,/fixture quota exhausted/);
});
