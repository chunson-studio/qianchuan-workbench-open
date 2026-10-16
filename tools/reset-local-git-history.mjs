// Explicit local-history reset. Never contacts or pushes to a remote.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const git=(root,args,options={})=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,...options}).trimEnd();
const exists=file=>{try{fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
function recycle(root,target) {
  if(path.dirname(target)!==root||!/^\.git(?:-next-[a-f0-9-]+)?$/.test(path.basename(target))||fs.lstatSync(target).isSymbolicLink())throw Error('invalid_recycle_target');
  execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',
    "$ErrorActionPreference='Stop'; $taskRoot=(Resolve-Path -LiteralPath $env:QC_GIT_RESET_ROOT).Path.TrimEnd('\\'); $target=Get-Item -LiteralPath $env:QC_GIT_RESET_TARGET -Force; if($target.Parent.FullName -ne $taskRoot -or $target.Name -notmatch '^\.git(-next-[a-f0-9-]+)?$' -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Target validation failed'}; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target.FullName,'OnlyErrorDialogs','SendToRecycleBin')"],
    {windowsHide:true,env:{...process.env,QC_GIT_RESET_ROOT:root,QC_GIT_RESET_TARGET:target},stdio:'pipe'});
  if(exists(target))throw Error('recycle_not_confirmed');
}
function byteCount(dir) {
  let bytes=0;for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,item.name);if(item.isSymbolicLink())continue;
    bytes+=item.isDirectory()?byteCount(file):fs.statSync(file).size;
  }return bytes;
}
export function resetLocalGitHistory({root,apply=false,message='当前版本'}) {
  root=fs.realpathSync(root);const old=path.join(root,'.git');
  if(process.platform!=='win32')throw Error('recycle_reset_requires_windows');
  if(!fs.lstatSync(old).isDirectory()||fs.lstatSync(old).isSymbolicLink())throw Error('ordinary_local_git_directory_required');
  if(fs.realpathSync(git(root,['rev-parse','--show-toplevel']))!==root)throw Error('exact_repository_root_required');
  if(git(root,['worktree','list','--porcelain']).split('\n').filter(x=>x.startsWith('worktree ')).length!==1)throw Error('shared_worktrees_require_separate_review');
  if(git(root,['stash','list']))throw Error('stash_requires_separate_review');
  for(const name of ['index.lock','HEAD.lock','config.lock','packed-refs.lock','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply'])if(exists(path.join(old,name)))throw Error('git_operation_in_progress:'+name);
  if(git(root,['ls-files','--stage','-z']).split('\0').some(row=>row.startsWith('160000 ')))throw Error('submodules_require_separate_review');
  const branch=git(root,['symbolic-ref','--short','HEAD']);
  const oldHead=git(root,['rev-parse','HEAD']);
  const inventory=()=>[...new Set(git(root,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))]
    .filter(name=>!name.startsWith('.git-next-')&&exists(path.join(root,name))).sort();
  const files=inventory(),config=fs.readFileSync(path.join(old,'config'));
  const before={branch,commits:Number(git(root,['rev-list','--all','--count'])),refs:git(root,['for-each-ref','--format=%(refname)']).split('\n').filter(Boolean),files:files.length,git_bytes:byteCount(old),remotes:git(root,['remote']).split('\n').filter(Boolean)};
  if(!apply)return {applied:false,...before,plan:'Preserve working files and remote configuration; replace local history with one commit; recycle old .git.'};
  if(!files.length)throw Error('empty_snapshot_refused');
  const candidate=path.join(root,'.git-next-'+randomUUID());let installed=false;
  const fresh=(args,options={})=>git(root,['--git-dir='+candidate,'--work-tree='+root,...args],options);
  try {
    git(root,['init','--bare','--initial-branch='+branch,candidate]);
    fs.writeFileSync(path.join(candidate,'config'),config);
    const excludes=path.join(old,'info','exclude');if(exists(excludes))fs.copyFileSync(excludes,path.join(candidate,'info','exclude'));
    fresh(['add','-f','--pathspec-from-file=-','--pathspec-file-nul'],{input:Buffer.from(files.join('\0')+'\0')});
    fresh(['commit','-m',message]);
    fresh(['diff','--no-ext-diff','--exit-code','HEAD','--']);
    fresh(['fsck','--full']);
    if(fresh(['rev-list','--all','--count'])!=='1')throw Error('candidate_history_not_single_commit');
    if(git(root,['rev-parse','HEAD'])!==oldHead||!fs.readFileSync(path.join(old,'config')).equals(config)
      ||JSON.stringify(inventory())!==JSON.stringify(files))throw Error('repository_changed_during_preparation');
    const commit=fresh(['rev-parse','HEAD']);
    recycle(root,old);
    // Both verified paths are siblings inside the intended repository root.
    fs.renameSync(candidate,old);installed=true;
    if(git(root,['rev-list','--all','--count'])!=='1'||git(root,['rev-parse','HEAD'])!==commit)throw Error('installed_history_verification_failed');
    git(root,['diff','--no-ext-diff','--exit-code','HEAD','--']);
    if(!fs.readFileSync(path.join(old,'config')).equals(config))throw Error('remote_configuration_changed');
    return {applied:true,commit,branch,commits:1,files:files.length,git_bytes_before:before.git_bytes,git_bytes_after:byteCount(old),old_metadata:'recycle_bin',remote_contacted:false};
  } finally {
    // If replacing the old metadata failed, retain the prepared repository for recovery.
    if(!installed&&exists(old)&&exists(candidate))recycle(root,candidate);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--apply')options.apply=true;
    else if(['--root','--message'].includes(args[i])&&args[i+1])options[args[i].slice(2)]=args[++i];
    else throw Error('Usage: node tools/reset-local-git-history.mjs --root <absolute repository root> [--apply] [--message <current-version message>]');
  }
  console.log(JSON.stringify(resetLocalGitHistory(options),null,2));
}
