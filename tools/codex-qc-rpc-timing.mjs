// Read-only audit of existing file-RPC jobs. Does not open browsers or submit work.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function timingSummary(rows, field) {
  const values = rows.map(row => row[field]).filter(value => Number.isFinite(value) && value >= 0).sort((a,b) => a-b);
  const percentile = fraction => values.length ? values[Math.ceil(values.length*fraction)-1] : null;
  return { sample_count: values.length, missing_count: rows.length-values.length,
    total_ms: values.length ? values.reduce((sum,value) => sum+value,0) : null,
    p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: values.at(-1) ?? null };
}

export async function auditJob(directory) {
  const rows = [];
  const pending = [];
  for (const name of (await fs.readdir(directory)).filter(n => n.endsWith('.request.json')).sort()) {
    const request = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    const responsePath = path.join(directory, name.replace('.request.json', '.response.json'));
    let stat;
    try { stat = await fs.stat(responsePath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; pending.push(request.id); continue; }
    const elapsed = stat.mtimeMs - Date.parse(request.at);
    const response=JSON.parse(await fs.readFile(responsePath,'utf8'));
    rows.push({ id: request.id, elapsed_ms: Number.isFinite(elapsed) ? Math.round(elapsed) : null,
      queue_ms:response.timing?.queue_ms??null,browser_ms:response.timing?.browser_ms??null,
      methods: request.steps.map(step => step.method ?? step.property).join(' > ') });
  }
  return { directory: path.resolve(directory), request_count: rows.length + pending.length,
    completed_count: rows.length, pending_ids: pending, first: rows[0] ?? null,
    timing_summary: { relay_wait: timingSummary(rows,'queue_ms'), browser_call: timingSummary(rows,'browser_ms') },
    slowest: rows.filter(r => r.elapsed_ms !== null).sort((a,b) => b.elapsed_ms-a.elapsed_ms).slice(0,5),
    caveat: 'Request-to-response time includes queueing, browser execution and local IO; not model-only or browser-only latency. relay_wait measures request creation to relay execution, not the plugin internal queue. browser_call may include plugin transport and page waits. Totals cover measured calls only, not the entire agent turn, and must not be added across overlapping jobs. Missing timing is null, not zero. Copied file timestamps can invalidate timing. Active jobs are partial snapshots.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = process.argv.slice(2);
  if (!directories.length) throw Error('usage: node tools/codex-qc-rpc-timing.mjs <job-directory> [job-directory...]');
  console.log(JSON.stringify(await Promise.all(directories.map(auditJob)), null, 2));
}
