// Isolated native Codex compaction probe. Only a localhost fake model is used.
// No existing thread, browser, credentials, or advertisement is accessed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

export async function probe({codex, percent=80, inputTokens=25000, autoLimit=30000, output, transport='exec', reloadPercent}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-compact-probe-'));
  const home=path.join(root,'home'), cwd=path.join(root,'workspace');
  await fs.mkdir(home); await fs.mkdir(cwd);
  const requests=[], events=[], errors=[];
  const server=http.createServer(async(req,res)=>{
    let raw=''; for await(const chunk of req) raw+=chunk;
    let body; try { body=JSON.parse(raw); } catch { body={}; }
    requests.push({path:req.url,at:Date.now(),inputCount:body.input?.length??0,
      lastInput:JSON.stringify(body.input?.at(-1)).slice(-1200)});
    if(req.url?.includes('/compact')) {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id:'cmp_fixture',object:'response.compaction',created_at:1,
        output:[{type:'compaction',encrypted_content:'fixture'}],
        usage:{input_tokens:inputTokens,output_tokens:20,total_tokens:inputTokens+20}}));return;
    }
    if(!req.url?.includes('/responses')||requests.length>4) {
      res.writeHead(400);res.end('fixture supports only bounded responses');return;
    }
    const n=requests.length, compact=JSON.stringify(body.input?.at(-1)).includes('CONTEXT CHECKPOINT COMPACTION');
    const text=compact?'Fixture checkpoint saved.':'Fixture business round complete.';
    const item={id:'msg_'+n,type:'message',role:'assistant',status:'completed',
      content:[{type:'output_text',text,annotations:[]}]};
    const response={id:'resp_'+n,object:'response',created_at:1,status:'completed',
      model:'gpt-6-astra',output:[item],usage:{input_tokens:compact?100:inputTokens,
        input_tokens_details:{cached_tokens:0},output_tokens:10,
        output_tokens_details:{reasoning_tokens:0},total_tokens:(compact?100:inputTokens)+10}};
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const emit=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    emit('response.created',{response:{...response,status:'in_progress',output:[]}});
    emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
    emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
    emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:text});
    emit('response.output_item.done',{output_index:0,item});
    emit('response.completed',{response});res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const cfg=`model = "gpt-6-astra"\nmodel_provider = "compact_fixture"\nmodel_context_window = 40000\nmodel_auto_compact_token_limit = ${autoLimit}\nmodel_post_turn_compact_threshold_percent = ${percent}\n[model_providers.compact_fixture]\nname = "Offline compaction fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nhooks = false\nmemories = false\n`;
  await fs.writeFile(path.join(home,'config.toml'),cfg);
  // Remove inherited API keys and host integration settings from the test process.
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>
    !/^(OPENAI|CODEX|CHATGPT|SKY|BROWSER_USE|NODE_REPL|MCP_)/i.test(k)));
  env.CODEX_HOME=home;
  let timedOut=false, out='',err='';
  const child=spawn(codex,transport==='server'?['app-server','--listen','stdio://']:['exec','--ephemeral','--skip-git-repo-check','--json',
    '--color','never','-C',cwd,'Reply only with the fixture completion message.'],
    {env,cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const exitPromise=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  // Attach a rejection handler immediately, including during RPC initialization.
  exitPromise.catch(()=>{});
  if(transport==='exec')child.stdin.end();
  child.stdout.on('data',x=>out+=x); child.stderr.on('data',x=>err+=x);
  const timer=setTimeout(()=>{timedOut=true;child.kill();},45000);
  let exitCode;
  try {
    if(transport==='server') {
      let seq=0,buffer='';const pending=new Map();
      child.once('exit',()=>{for(const p of pending.values())p.reject(new Error('fixture host exited before RPC response'));pending.clear();});
      child.once('error',error=>{for(const p of pending.values())p.reject(error);pending.clear();});
      child.stdout.on('data',chunk=>{buffer+=chunk;let nl;while((nl=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);let msg;try{msg=JSON.parse(line);}catch{continue;}
        if(msg.id!==undefined&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);
          msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}
      }});
      const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});
        child.stdin.write(JSON.stringify({id,method,params})+'\n');});
      await rpc('initialize',{clientInfo:{name:'offline_compact_probe',version:'1.0'},capabilities:{experimentalApi:true}});
      child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
      const started=await rpc('thread/start',{cwd,ephemeral:true,model:'gpt-6-astra',
        modelProvider:'compact_fixture',approvalPolicy:'never',sandbox:'read-only'});
      const round=async()=>{
        const offset=out.length;
        await rpc('turn/start',{threadId:started.thread.id,input:[{type:'text',text:'Reply only with the fixture completion message.'}]});
        const deadline=Date.now()+20000;
        while(!out.slice(offset).includes('"method":"turn/completed"')){
          if(Date.now()>deadline)throw new Error('fixture turn completion timeout');
          await new Promise(r=>setTimeout(r,50));
        }
      };
      await round();
      if(reloadPercent!==undefined){
        await fs.writeFile(path.join(home,'config.toml'),cfg.replace(`threshold_percent = ${percent}`,`threshold_percent = ${reloadPercent}`));
        // Reset provider response usage for the next independent round.
        requests.push({marker:'config_changed',percent:reloadPercent});
        await round();
      }
      child.stdin.end();
    }
    exitCode=await exitPromise;
  }
  finally {clearTimeout(timer);if(child.exitCode===null)child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
  for(const line of out.split(/\r?\n/))if(line.trim()){
    try{const event=JSON.parse(line);if(transport==='exec'||['turn/completed','item/started','item/completed','thread/tokenUsage/updated','error'].includes(event.method))events.push(event);}catch{errors.push(line);}
  }
  const result={percent,inputTokens,autoLimit,transport,reloadPercent,exitCode,timedOut,requests,events,
    errors,stderr:err.slice(-6000),isolatedRoot:root};
  if(output)await fs.writeFile(output,JSON.stringify(result,null,2));
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{codex:{type:'string'},percent:{type:'string',default:'80'},
    tokens:{type:'string',default:'25000'},limit:{type:'string',default:'30000'},output:{type:'string'},transport:{type:'string',default:'exec'},reload:{type:'string'}}});
  const r=await probe({codex:values.codex??'codex',percent:Number(values.percent),
    inputTokens:Number(values.tokens),autoLimit:Number(values.limit),output:values.output,transport:values.transport,
    reloadPercent:values.reload===undefined?undefined:Number(values.reload)});
  console.log(JSON.stringify(r));process.exitCode=r.exitCode===0&&!r.timedOut?0:1;
}
