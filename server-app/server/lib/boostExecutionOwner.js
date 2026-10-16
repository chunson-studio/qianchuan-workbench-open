'use strict';
const fs = require('node:fs');
const path = require('node:path');
// 协作归属闸，不代替账户授权；登记后不接受另一个脚本或无归属请求。
function assertBoostExecutionOwner(req, accountId, primaryAdId, root = require('./config').RUNTIME_DATA_ROOT) {
  const owner = req.headers?.['x-qc-execution-owner'], session = req.headers?.['x-qc-session-key'];
  const fail = (code, message) => { throw Object.assign(new Error(message), {code, statusCode:409, skipOpLog:true, advertising_writes:0}); };
  if (!/^[A-Za-z0-9_-]+$/.test(String(accountId)) || !/^\d+$/.test(String(primaryAdId))) {
    fail('execution_scope_invalid', '追投写操作必须明确账户和主计划，不能跳过执行归属核验');
  }
  const file = path.join(root, 'boost-runner', String(accountId), String(primaryAdId), 'owner.json');
  let lease;
  try { lease = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') fail('execution_owner_unreadable', '执行归属文件损坏，保留原文件并核对');
    if (owner || session) fail('execution_owner_missing', '服务端未找到执行归属；核对运行目录和版本');
    return;
  }
  if (!lease || lease.status !== 'active') fail('execution_owner_stopped', '该计划的脚本归属已停止；不能用其他入口恢复写入');
  if (!owner || lease.owner !== owner || !session || lease.session_key !== session) fail('execution_owner_conflict', '该主计划由其他执行归属管理；请先交接，不能并行调用写入口');
}
const runtimeIdentity = root => require('node:crypto').createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
module.exports = {assertBoostExecutionOwner, runtimeIdentity};
