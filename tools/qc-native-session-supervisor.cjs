'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');

// Process lifecycle only. Never submits, replays requests, navigates or changes Chrome.
function superviseQianchuanNativeSession({configFile,runtimeFile,restartDelayMs=1000},dependencies={}) {
  if(!path.isAbsolute(configFile||'')||!path.isAbsolute(runtimeFile||'')||!Number.isInteger(restartDelayMs)||restartDelayMs<1||restartDelayMs>10000)throw Error('native_supervisor_config_invalid');
  const statusFile=runtimeFile+'.supervisor.json';
  const launch=dependencies.spawn??spawn,save=dependencies.save??(value=>fs.writeFileSync(statusFile,JSON.stringify(value,null,2)+'\n',{mode:0o600}));
  const emit=dependencies.emit??(value=>process.stdout.write(JSON.stringify(value)+'\n'));
  const state={supervisor_pid:process.pid,child_pid:null,status:'starting',restart_count:0,restart_limit:1,started_at:new Date().toISOString()};
  let child,timer,stopping=false,finished=false,resolveDone;
  const done=new Promise(resolve=>{resolveDone=resolve;});
  const publish=()=>{state.updated_at=new Date().toISOString();save({...state});emit({...state});};
  const finish=status=>{if(finished)return;finished=true;clearTimeout(timer);state.status=status;state.child_pid=null;publish();resolveDone({...state});};
  function start(){
    if(stopping||finished)return;
    state.status=state.restart_count?'reconnecting':'starting';publish();
    let ready=false;const buffers={stdout:'',stderr:''};
    try{child=launch(process.execPath,[path.join(__dirname,'start-qc-native-session.cjs'),'--config',configFile],
      {cwd:path.resolve(__dirname,'..'),windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch{state.last_code='native_supervisor_spawn_failed';finish('failed');return;}
    state.child_pid=child.pid??null;publish();
    const observe=channel=>chunk=>{
      let buffer=buffers[channel]+String(chunk);if(buffer.length>65536)buffer=buffer.slice(-65536);
      for(let end;(end=buffer.indexOf('\n'))>=0;){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let value;
        try{value=JSON.parse(line);}catch{continue;}
        if(value.status==='running'&&value.pid===child.pid){ready=true;state.status='running';state.host_id=value.host_id;delete state.last_code;delete state.last_failure;publish();}
        else if(['start_failed','stop_failed'].includes(value.status)){
          const failure=require('./start-qc-native-session.cjs').publicNativeSessionFailure(value);
          state.last_code=failure.code;state.last_failure=failure;
        }
      }
      buffers[channel]=buffer;
    };
    child.stdout?.on('data',observe('stdout'));child.stderr?.on('data',observe('stderr'));
    child.once('error',()=>{state.last_code='native_supervisor_spawn_failed';finish('failed');});
    child.once('exit',(code,signal)=>{
      if(finished)return;state.last_exit_code=code;state.last_exit_signal=signal;state.child_pid=null;
      if(stopping){finish('stopped');return;}
      // A failed first attach never loops over Chrome's permission handshake.
      if(!ready||state.restart_count>=state.restart_limit){finish('failed');return;}
      state.restart_count++;state.status='reconnecting';publish();timer=setTimeout(start,restartDelayMs);
    });
  }
  const stop=()=>{stopping=true;clearTimeout(timer);if(child?.exitCode==null&&!child?.killed)child.kill();else finish('stopped');return done;};
  start();
  return{done,stop,statusFile,snapshot:()=>({...state})};
}
module.exports={superviseQianchuanNativeSession};
