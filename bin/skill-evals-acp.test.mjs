import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AcpClient,evaluate,nativeCost,parseOptions,prepareNative,authorizeArtifactRead} from './skill-evals-acp.mjs';
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
