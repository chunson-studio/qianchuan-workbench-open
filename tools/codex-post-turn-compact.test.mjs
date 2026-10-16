import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {probe} from './codex-post-turn-compact-probe.mjs';
import {patchConfig} from './codex-post-turn-compact-config.mjs';

test('preserves notify and tables, changes only root key, is idempotent',()=>{
  const original='model = "example"\r\nnotify = ["keep.exe"]\r\n[desktop]\r\na = true\r\n';
  const patched=patchConfig(original,75);
  assert.ok(patched.endsWith(original));assert.equal(patchConfig(patched,75),patched);
  assert.equal(patchConfig(patched,70),patched.replace('= 75','= 70'));
  assert.throws(()=>patchConfig(original,101));
});
test('native app-server post-turn behavior and reload boundary', {skip:!process.env.QC_COMPACT_PROBE_CODEX}, async()=>{
  const cases=[
    {name:'below_threshold',percent:75,inputTokens:28000,expected:0},
    {name:'above_threshold',percent:75,inputTokens:29000,expected:1},
    {name:'loaded_thread_keeps_old_config',percent:100,inputTokens:29000,reloadPercent:75,expected:0}
  ];
  const results=[];
  for(const c of cases){
    const r=await probe({codex:process.env.QC_COMPACT_PROBE_CODEX,transport:'server',autoLimit:35000,...c});
    assert.equal(r.exitCode,0);assert.equal(r.timedOut,false);
    const compact=r.events.filter(e=>e.method==='item/completed'&&e.params.item.type==='contextCompaction');
    assert.equal(compact.length,c.expected,c.name);
    if(c.expected){
      const agent=r.events.findIndex(e=>e.method==='item/completed'&&e.params.item.type==='agentMessage');
      const start=r.events.findIndex(e=>e.method==='item/started'&&e.params.item.type==='contextCompaction');
      const end=r.events.findIndex(e=>e.method==='turn/completed');
      assert.ok(agent<start&&start<end,'native compaction follows final message and precedes turn completion');
    }
    results.push({name:c.name,...r});
  }
  if(process.env.QC_COMPACT_PROBE_EVIDENCE){
    const dest=path.resolve(process.env.QC_COMPACT_PROBE_EVIDENCE);await fs.mkdir(path.dirname(dest),{recursive:true});
    await fs.writeFile(dest,JSON.stringify({passed:true,model_backend:'localhost fixture',live_threads_touched:0,results},null,2));
  }
});
