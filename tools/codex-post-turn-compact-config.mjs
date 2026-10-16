import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const key='model_post_turn_compact_threshold_percent';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function restoreDefaults(text){
  const section=text.search(/^\s*\[/m),end=section<0?text.length:section;
  const head=text.slice(0,end),tail=text.slice(end);
  const matcher=new RegExp('^'+key+'\\s*=[^\\r\\n]*(?:\\r?\\n|$)','gm');
  if((head.match(matcher)||[]).length>1)throw new Error('duplicate root compaction setting');
  return head.replace(matcher,'')+tail;
}
export function patchConfig(text,percent){
  if(!Number.isInteger(percent)||percent<1||percent>100)throw new Error('percent must be an integer 1..100');
  const eol=text.includes('\r\n')?'\r\n':'\n';
  const section=text.search(/^\s*\[/m),end=section<0?text.length:section;
  const head=text.slice(0,end),tail=text.slice(end);
  const matcher=new RegExp('^'+key+'\\s*=.*$','gm');
  const matches=head.match(matcher)||[];
  if(matches.length>1)throw new Error('duplicate root compaction setting');
  return matches.length?head.replace(matcher,`${key} = ${percent}`)+tail:
    `${key} = ${percent}${eol}${text}`;
}
export async function configure({config,codex,percent=75,apply=false,restore=false}){
  const before=await fs.readFile(config),text=before.toString('utf8');
  // This command loads the native configuration and validates the candidate key.
  const checked=spawnSync(codex,restore?['features','list']:['-c',`${key}=${percent}`,'features','list'],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(checked.status!==0)throw new Error('native config validation failed: '+checked.stderr);
  const next=restore?restoreDefaults(text):patchConfig(text,percent);
  if(restore)percent=null;
  if(!apply)return {mode:'preview',key,percent,changed:next!==text};
  if(next===text)return {mode:'unchanged',key,percent,config,existing_threads_require_reload:true};
  const backupDir=path.join(path.dirname(config),'backups','post-turn-compaction');
  await fs.mkdir(backupDir,{recursive:true});
  const backup=path.join(backupDir,`config-${Date.now()}.toml`);
  await fs.writeFile(backup,before,{flag:'wx'});
  if(hash(await fs.readFile(config))!==hash(before))throw new Error('config changed concurrently; retry from fresh read');
  await fs.writeFile(config,next);
  if((await fs.readFile(config,'utf8'))!==next)throw new Error('config readback mismatch');
  return {mode:'applied',key,percent,config,backup,before_sha256:hash(before),after_sha256:hash(next),
    existing_threads_require_reload:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{config:{type:'string'},codex:{type:'string'},
    percent:{type:'string',default:'75'},apply:{type:'boolean',default:false},'restore-defaults':{type:'boolean',default:false}}});
  console.log(JSON.stringify(await configure({config:values.config??path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'config.toml'),
    codex:values.codex??'codex',percent:Number(values.percent),apply:values.apply,restore:values['restore-defaults']})));
}
