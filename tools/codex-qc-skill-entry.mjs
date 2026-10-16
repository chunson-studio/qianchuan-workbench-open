// Read the current Skill text when it is not already loaded in this context.
// A hash receipt proves file identity, not that a model obeyed its contents.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export async function readSkillEntry({known_hash=null,skill_url=new URL('../skills/qianchuan-ops/SKILL.md',import.meta.url)}={}) {
  const bytes=await readFile(skill_url),skill_hash=createHash('sha256').update(bytes).digest('hex');
  const required_read=known_hash!==skill_hash;
  return {skill_path:fileURLToPath(skill_url),skill_hash,required_read,
    ...(required_read?{content:bytes.toString('utf8')}:{reuse:'already_read_in_current_context'}),
    grants_authorization:false,advertising_writes:0};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--known-hash'&&/^[a-f0-9]{64}$/.test(args[1])))throw Error('usage: node tools/codex-qc-skill-entry.mjs [--known-hash SHA256]');
  console.log(JSON.stringify(await readSkillEntry({known_hash:args[1]??null})));
}
