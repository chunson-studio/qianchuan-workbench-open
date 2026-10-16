'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readQianchuanNativeConfig } = require('./start-qc-native-session.cjs');
const { createQianchuanNativeClient } = require('./qc-native-session-client.cjs');

/** Run bounded, read-only waves against an existing independent owner.
 * No CDP attachment, refresh, page mutation, advertising writes or retries.
 * Full snapshots are returned only for explicit maintenance evidence.
 */
async function checkQianchuanNativeClient({ configFile, operation = 'snapshot', input = {}, rounds = 3, timeoutMs = 20000 }) {
  if (!['snapshot', 'read_control', 'auxiliary_list'].includes(operation) ||
      !Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('native_check_options_invalid');
  const config = readQianchuanNativeConfig(configFile);
  const client = createQianchuanNativeClient({ runtimeFile: config.runtimeFile, timeoutMs });
  const results = [], started = Date.now();
  for (let round = 1; round <= rounds; round++) {
    const start = Date.now();
    const rooms = await Promise.all(config.bindings.map(async binding => {
      const at = Date.now(), request_id = 'check_' + crypto.randomUUID();
      const request = { room: binding.room, account_id: binding.account_id, advertiser_id: binding.advertiser_id,
        primary_ad_id: binding.primary_ad_id, request_id, operation, input };
      try {
        const response = await client.call(request);
        return { room: binding.room, elapsed_ms: Date.now() - at,
          passed: response.ok === true && response.state === 'completed' && response.result?.ok === true &&
            (operation !== 'read_control' || response.result.complete === true), response };
      } catch (error) {
        return { room: binding.room, elapsed_ms: Date.now() - at, passed: false,
          code: error.code || 'native_check_failed', request_id, retry_write: false };
      }
    }));
    results.push({ round, elapsed_ms: Date.now() - start, rooms });
  }
  return { ok: results.every(round => round.rooms.every(room => room.passed)), client_pid: process.pid,
    host_id: client.host_id, captured_at: new Date().toISOString(), operation, rounds: results,
    elapsed_ms: Date.now() - started, advertising_writes: 0,
    scope: operation === 'read_control' ? 'Current selected pool completeness; no refresh or business judgment' : 'Current page/auxiliary snapshot; no complete-pool or business acceptance' };
}
if (require.main === module) {
  const [configFile, outputFile, operation = 'snapshot', inputText = '{}'] = process.argv.slice(2);
  if (!path.isAbsolute(outputFile || '')) throw new Error('native_check_output_path_required');
  checkQianchuanNativeClient({ configFile, operation, input: JSON.parse(inputText) }).then(result => {
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ok: result.ok, client_pid: result.client_pid, operation,
      rounds: result.rounds.map(round => ({ round: round.round, elapsed_ms: round.elapsed_ms,
        rooms: round.rooms.map(room => ({ room: room.room, passed: room.passed, elapsed_ms: room.elapsed_ms,
          state: room.response?.state, code: room.code || room.response?.operation_code || room.response?.code,
          rows: room.response?.result?.visible_rows, total: room.response?.result?.total })) })) }) + '\n');
    if (!result.ok) process.exitCode = 1;
  }).catch(error => { process.stderr.write((error.code || 'native_check_failed') + '\n'); process.exitCode = 1; });
}
module.exports = { checkQianchuanNativeClient };
