// Protocol fixture, not a native harness qualification or a model invocation.
import {agent, methods, ndJsonStream} from '@agentclientprotocol/sdk';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
let mcp;
const app=agent({name:'fixture',version:'fixture-1'})
.onRequest(methods.agent.initialize,()=>({protocolVersion:1,agentInfo:{name:'fixture',version:'fixture-1'},agentCapabilities:{sessionCapabilities:{close:{}}}}))
.onRequest(methods.agent.session.new,async({params})=>{
 if(params.mcpServers.length){
  const s=params.mcpServers[0]; mcp=new Client({name:'fixture',version:'1'});
  await mcp.connect(new StdioClientTransport({command:s.command,args:s.args,stderr:'ignore'}));
 }
 return{sessionId:'fixture',configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'fixture/model',options:[{value:'fixture/model',name:'Fixture'}]}]};
})
.onRequest(methods.agent.session.prompt,async ctx=>{
 if(process.env.EVAL_FIXTURE_QUOTA_NOTICE==='1'){
  await ctx.client.notify(methods.client.session.update,{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 64h37m24s.\n'}}});
  return {stopReason:'end_turn'};
 }
 if(process.env.EVAL_FIXTURE_QUOTA==='1')throw Object.assign(Error('RESOURCE_EXHAUSTED: fixture quota exhausted'),{code:-32603});
 let text='{"passed":true,"explanation":"Observed the actual bounded skill load."}';
 if(mcp){
  const list=await mcp.listTools();
  if(process.env.EVAL_FIXTURE_SKIP_SKILL!=='1' && list.tools.some(t=>t.name==='Skill')) {
   const result=await mcp.callTool({name:'Skill',arguments:{skill:'triage'}});
   if(process.env.EVAL_FIXTURE_ARTIFACT==='1'){
    const gemini=process.argv[process.argv.indexOf('--gemini-dir')+1];
    const output=path.join(gemini,'antigravity-cli','brain','fixture','.system_generated','steps','2','output.txt');
    mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,result.content[0].text);
    await ctx.client.notify(methods.client.session.update,{sessionId:'fixture',update:{sessionUpdate:'tool_call',toolCallId:'spill',title:'Read own output',kind:'read',rawInput:{Path:output}}});
    const permission=await ctx.client.request(methods.client.session.requestPermission,{sessionId:'fixture',toolCall:{toolCallId:'spill'},options:[{kind:'allow_once',optionId:'once',name:'Allow once'}]});
    if(permission.outcome.outcome!=='selected'||readFileSync(output,'utf8')!==result.content[0].text)throw Error('Bounded native spill permission failed');
   }
  }
  if(process.env.EVAL_FIXTURE_DENIED==='1') await mcp.callTool({name:'Read',arguments:{path:'/etc/passwd'}});
  text='Inspect probe.service using journalctl -u probe.service';
 }
 await ctx.client.notify(methods.client.session.update,{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}});
 await ctx.client.notify(methods.client.session.update,{sessionId:'fixture',update:{sessionUpdate:'usage_update',used:200,size:10000,cost:{amount:0.01,currency:'USD'}}});
 return {stopReason:'end_turn'};
})
.onRequest(methods.agent.session.close,async()=>{if(mcp)await mcp.close();return{};});
const conn=app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
await conn.closed;
