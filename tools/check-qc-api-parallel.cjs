'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

async function checkQianchuanApiParallel({ bindings, date, rounds = 3, timeout_ms = 10000, pool = 'active' }, options = {}) {
  if (!Array.isArray(bindings) || !bindings.length || !Number.isInteger(rounds) || rounds < 1 || rounds > 10
      || !Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 60000 || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')
      || !['active', 'manual_paused'].includes(pool)) throw Error('invalid_benchmark');
  for (const b of bindings) if (typeof b.room !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(b.account_id || '')
      || typeof b.advertiser_id !== 'string' || !/^\d+$/.test(b.advertiser_id)
      || typeof b.primary_ad_id !== 'string' || !/^\d+$/.test(b.primary_ad_id)) throw Error('invalid_binding');
  const read = options.read || (async (b, signal) => {
    const { validateAccount } = require('../server-app/server/lib/api-helpers');
    const { resolveAavid } = require('../server-app/server/lib/cookie');
    validateAccount(b.account_id);
    if (resolveAavid(b.account_id) !== b.advertiser_id) throw Object.assign(Error('binding'), { code: 'advertiser_binding_mismatch' });
    return require('../server-app/server/lib/qianchuanTabs').fetchBoostList(b.primary_ad_id, date, date, b.account_id,
      { pool, pageSize: 100, signal });
  });
  const result = { ok: true, kind: 'real_api_read_benchmark', captured_at: new Date().toISOString(), date,
    scope: pool === 'active' ? 'active_tasks' : 'manual_paused_tasks', timing_scope: 'request_queue_and_api_read_not_model_decision', rounds: [] };
  for (let round = 0; round < rounds; round++) {
    const began = performance.now();
    const rooms = await Promise.all(bindings.map(async b => {
      const controller = new AbortController(), started = performance.now();
      let timer;
      try {
        const response = await Promise.race([Promise.resolve().then(() => read(b, controller.signal)),
          new Promise((_resolve, reject) => { timer = setTimeout(() => {
            const error = Object.assign(Error('timeout'), { code: 'benchmark_read_timeout' }); controller.abort(error); reject(error);
          }, timeout_ms); })]);
        const rows = response?.data?.adInfos, total = response?.data?.pagination?.totalNum;
        const complete = (response?.status_code ?? response?.code) === 0 && response.truncated === false
          && Array.isArray(rows) && !Object.keys(response.data.moduleErrors || {}).length
          && new Set(rows.map(t => t.id)).size === rows.length && (total != null && Number(total) === rows.length)
          && rows.every(t => t.advId === b.advertiser_id);
        return { ...b, ok: complete, state: complete ? 'complete' : 'unknown', elapsed_ms: performance.now() - started,
          task_count: complete ? rows.length : null, retrieved_at: new Date().toISOString(), platform_updated_at: null,
          result: response };
      } catch (error) { return { ...b, ok: false, state: 'unknown', task_count: null, elapsed_ms: performance.now() - started,
        code: /^[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'api_read_failed' }; }
      finally { clearTimeout(timer); }
    }));
    result.rounds.push({ round: round + 1, elapsed_ms: performance.now() - began, rooms });
    if (rooms.some(r => !r.ok)) { result.ok = false; break; }
  }
  return result;
}
if (require.main === module) (async () => {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output)) throw Error('absolute_files_required');
  const result = await checkQianchuanApiParallel(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, rounds: result.rounds.map(r => ({ round: r.round, elapsed_ms: r.elapsed_ms,
    rooms: r.rooms.map(({ room, ok, task_count, elapsed_ms, code }) => ({ room, ok, task_count, elapsed_ms, code })) })) }));
  if (!result.ok) process.exitCode = 2;
})().catch(() => { console.error(JSON.stringify({ ok: false, code: 'benchmark_failed' })); process.exitCode = 1; });
module.exports = { checkQianchuanApiParallel };
