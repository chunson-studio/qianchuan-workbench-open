'use strict';
// 单轮 GET 采集与本地投影；不发起广告写入，不建立定时器。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveBoostWriteScope, describeExecutionPolicy } = require('../server-app/server/lib/agentPolicy');
const number = value => value == null || value === '' || typeof value === 'boolean' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
function time(value) {
  if (value == null || value === '') return NaN;
  if (/^\d+(\.\d+)?$/.test(String(value))) return Number(value) < 1e12 ? Number(value) * 1000 : Number(value);
  const text = String(value).replace(' ', 'T');
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(text) ? text + '+08:00' : text);
}
const day = value => new Date(time(value) + 8 * 3600000).toISOString().slice(0, 10);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = (at, now) => Number.isFinite(time(at)) && now - time(at) >= -5000 && now - time(at) <= 90000;
const failure = code => Object.assign(new Error(code), { code });
function loadScope(file, binding) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let config;
  try { config = JSON.parse(raw); }
  catch { throw failure('invalid_config_json'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.qianchuan_accounts)) throw failure('invalid_config_shape');
  if (!config.qianchuan_accounts.some(a => a?.id === binding.account_id)) throw failure('account_not_configured');
  const policy = config.agent_policy?.account_policies ? config.agent_policy.account_policies[binding.account_id] : config.agent_policy;
  if (!policy) throw failure('account_policy_unavailable');
  const selected = resolveBoostWriteScope(policy, binding.primary_ad_id);
  const scope = selected.binding;
  if (selected.code || !scope || String(scope.room_id) !== binding.room_id || time(scope.session_started_at) !== time(binding.start_time))
    throw failure(selected.code || 'policy_session_mismatch');
  const plans = Array.isArray(scope.primary_ad_id) ? scope.primary_ad_id : [scope.primary_ad_id];
  if (!plans.map(String).includes(binding.primary_ad_id)) throw failure('policy_plan_mismatch');
  const projected = describeExecutionPolicy({ boost_write_scope: scope }, binding.account_id).boost_write_scope;
  const protectedIds = policy.protected_object_ids || [];
  if (!Array.isArray(protectedIds)) throw failure('invalid_protected_objects');
  return { scope, protectedIds, digest: hash({ scope: projected, protectedIds }), projected };
}
function buildBrief(binding, summary, list, policy, now = Date.now()) {
  const errors = [];
  const countErrors = [];
  const countError = code => { errors.push(code); countErrors.push(code); };
  const meta = summary?.meta || {}, live = summary?.live || {};
  if (summary?.ok === false || meta.account_id !== binding.account_id || String(live.room_id) !== binding.room_id
    || time(live.start_time) !== time(binding.start_time)) errors.push('live_binding_unverified');
  if (live.is_live !== true || !fresh(live.live_checked_at, now)) errors.push('live_status_unverified');
  if (meta.data_valid !== true || meta.stale === true || !fresh(meta.source_at, now) || summary?.metrics_scope !== 'current_session') errors.push('live_data_unavailable');
  if (summary?.financial_checks?.net_roi?.roi_basis !== 'platform_net_1h'
    || summary?.financial_checks?.net_roi?.data_valid !== true) errors.push('net_roi_basis_unknown');
  if (!summary?.snapshot_id) errors.push('snapshot_unavailable');
  if (list?.ok !== true || list.account !== binding.account_id || String(list.ad_id) !== binding.primary_ad_id) countError('boost_binding_unverified');
  if (list?.data_valid !== true || list?.truncated !== false || !Array.isArray(list?.tasks)) countError('boost_list_incomplete');
  const tasks = Array.isArray(list?.tasks) ? list.tasks : [];
  if (!fresh(list?.source_at, now) || tasks.some(t => !fresh(t.source_at, now))) countError('boost_data_stale');
  if (list?.date_range !== `${day(binding.start_time)} ~ ${day(now)}` || list?.total_tasks !== tasks.length) countError('boost_window_unverified');
  // Enabled upstream tasks may be waiting for a live room; they are not delivering now.
  const isActive = t => t.status === '投放中' || (t.status == null && t.status_code === 1);
  const isPaused = t => t.status_code === 2 || ['已暂停', '暂停中', '暂停投放'].includes(t.status);
  const ids = new Set();
  for (const t of tasks) {
    if (!t.id || ids.has(String(t.id)) || String(t.primary_ad_id) !== binding.primary_ad_id) countError('boost_identity_invalid');
    ids.add(String(t.id));
    if ((t.status_code === 1 && isPaused({ status: t.status })) || (t.status_code === 2 && isActive({ status: t.status }))) countError('boost_status_conflict');
    if (!isActive(t) && !isPaused(t) && !['已完成','已结束','投放结束','已删除','已终止','已停止','关联直播间未开播'].includes(t.status)) countError('boost_status_unknown');
  }
  const h = policy.scope.hysteresis_rules;
  const required = ['pause_active_below','resume_paused_at_or_above','hard_stop_below','zero_order_gate_yuan'];
  if (!h || required.some(key => typeof h[key] !== 'number' || !Number.isFinite(h[key]) || h[key] < 0)
    || h.resume_paused_at_or_above <= h.pause_active_below || h.hard_stop_below > h.pause_active_below
    || policy.scope.judgment_basis?.primary !== 'net_roi') errors.push('controller_rules_unavailable');
  const max = policy.scope.concurrency?.max_active_tasks;
  if (max != null && (!Number.isSafeInteger(max) || max < 0)) errors.push('invalid_concurrency_limit');
  const active = tasks.filter(isActive), paused = tasks.filter(isPaused), suggestions = [], missing = [];
  let slots = max == null ? 0 : Math.max(0, max - active.length);
  const allowed = policy.scope.allowed_actions || [];
  if (!errors.length) for (const t of tasks.filter(t => isActive(t) || isPaused(t))) {
    const id = String(t.id), created = time(t.create_time);
    const carryover = Number.isFinite(created) && day(t.create_time) === day(binding.start_time)
      && policy.scope.carryover_task_ids?.map(String).includes(id);
    if (!Number.isFinite(created) || created > now || (created < time(binding.start_time) && !carryover)) { missing.push({ id, code: 'task_outside_session' }); continue; }
    const cost = number(t.cost), orders = number(t.order_count), roi = number(t.net_roi);
    if (cost == null || cost < 0 || orders == null || !Number.isInteger(orders) || orders < 0 || t.metric_roi_basis?.net_roi !== 'platform_net_1h'
      || (orders > 0 && (roi == null || roi < 0))) { missing.push({ id, code: 'task_metrics_unavailable' }); continue; }
    let action, reason;
    if (isActive(t) && orders === 0 && cost >= h.zero_order_gate_yuan) { action = 'pause'; reason = 'zero_order_gate'; }
    else if (isActive(t) && orders > 0 && roi < h.pause_active_below) { action = 'pause'; reason = roi < h.hard_stop_below ? 'hard_stop' : 'below_pause_line'; }
    else if (isPaused(t) && orders > 0 && roi >= h.resume_paused_at_or_above && cost >= h.zero_order_gate_yuan) { action = 'resume'; reason = 'above_resume_line'; }
    if (!action) continue;
    const targets = policy.scope.action_target_ids?.[action], expiry = policy.scope.action_expires_at?.[action];
    if (!allowed.includes(action) || policy.protectedIds.map(String).includes(id) || t.available_actions?.[action]?.allowed === false
      || (targets && !targets.map(String).includes(id)) || (expiry != null && !(time(expiry) > now))) {
      missing.push({ id, code: 'action_requires_review' }); continue;
    }
    if (action === 'resume' && !slots) { missing.push({ id, code: max == null ? 'resume_capacity_not_configured' : 'concurrency_limit_exceeded' }); continue; }
    if (action === 'resume') slots--;
    suggestions.push({ action, id, reason, cost, orders, net_roi: roi, metric_scope: 'task_date_range' });
  }
  const valid = errors.length === 0;
  const m = summary?.metrics || {};
  const payment = number(m.payment_gmv), net = number(m.net_gmv);
  return { schema_version: 1, ok: valid, executable: false, binding, policy_digest: policy.digest,
    source_at: { live: meta.source_at || null, boost: list?.source_at || null },
    snapshot_id: summary?.snapshot_id || meta.snapshot_id || null,
    quality: { data_valid: valid, partial: meta.partial === true, errors: [...new Set(errors)], missing },
    metrics: { cost: number(m.spend), payment_roi: number(m.payment_roi), net_roi: number(m.net_roi),
      payment_minus_net_gmv: payment != null && net != null ? +(payment - net).toFixed(2) : null, roi_basis: 'platform_net_1h' },
    counts: { active: countErrors.length ? null : active.length, paused: countErrors.length ? null : paused.length,
      awaiting_live: countErrors.length ? null : tasks.filter(t => t.status === '关联直播间未开播').length },
    counts_quality: { data_valid: countErrors.length === 0, errors: [...new Set(countErrors)], scope: 'primary_plan_date_range' },
    suggestions, next_step: valid ? '按本次查询范围核对来源时间与指标口径；本结果用于独立分析' : '补读错误涉及的对象，不据缺失值操作' };
}
function formatHeartbeat(brief, briefFile) {
  const metric = value => number(value) == null ? '未知' : String(number(value));
  // Quoting preserves complete identities and paths while preventing embedded newlines.
  const atom = value => JSON.stringify(value == null || value === '' ? '未知' : String(value));
  const size = value => Array.isArray(value) ? value.length : null;
  const q = brief.quality || {}, m = brief.metrics || {}, b = brief.binding || {};
  const errors = size(q.errors), missing = size(q.missing), suggestions = size(brief.suggestions);
  const values = [m.cost, m.payment_roi, m.net_roi, m.payment_minus_net_gmv];
  const qualityIssue = brief.ok !== true || q.data_valid !== true || q.partial !== false
    || errors !== 0 || missing !== 0 || values.some(value => number(value) == null);
  const line = [
    '未执行', `消耗=${metric(m.cost)}`, `支付ROI=${metric(m.payment_roi)}`, `净1hROI=${metric(m.net_roi)}`,
    `支净差=${metric(m.payment_minus_net_gmv)}`, `在投=${metric(brief.counts?.active)}`, `暂停=${metric(brief.counts?.paused)}`,
    `待直播=${metric(brief.counts?.awaiting_live)}`,
    `质量=${q.data_valid !== true ? '未知' : qualityIssue ? '部分' : '有效'}`,
    `错误=${metric(errors)}`, `任务缺项=${metric(missing)}`, `建议=${metric(suggestions)}`,
    `account=${atom(b.account_id)}`, `plan=${atom(b.primary_ad_id)}`, `room=${atom(b.room_id)}`, `start=${atom(b.start_time)}`,
    `live_at=${atom(brief.source_at?.live)}`, `boost_at=${atom(brief.source_at?.boost)}`,
    `snapshot_id=${atom(brief.snapshot_id)}`, `policy_digest=${atom(brief.policy_digest)}`, `brief_file=${atom(briefFile)}`,
  ].join(' ');
  return line + (qualityIssue || suggestions !== 0 ? '\n建议或质量问题待核对；按 brief_file 定点读取完整证据；未执行。' : '');
}
async function collectBrief(options, fetchImpl = globalThis.fetch) {
  const { binding } = options;
  const url = new URL(options.url);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password) throw failure('local_service_required');
  const policy = loadScope(options.config, binding);
  const date = day(binding.start_time), today = day(new Date().toISOString());
  const get = async (pathname, params) => {
    const target = new URL(pathname, url); target.search = new URLSearchParams(params).toString();
    const response = await fetchImpl(target, { method: 'GET', signal: AbortSignal.timeout(55000), redirect: 'error' });
    const body = await response.json();
    if (!response.ok || body?.ok === false) return { ok: false, code: body?.code || `http_${response.status}` };
    return body;
  };
  const results = await Promise.allSettled([
    get('/api/live-summary', { account: binding.account_id, room_id: binding.room_id, start_time: binding.start_time, include_boosts: '0' }),
    get('/api/boost-list', { account: binding.account_id, adId: binding.primary_ad_id, start: date, end: today, includeAllStatus: '1' }),
  ]);
  const [summary, list] = results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, code: r.reason?.code || r.reason?.name || 'read_failed' });
  const brief = buildBrief(binding, summary, list, policy);
  for (const result of [summary, list]) if (result?.ok === false && result.code) brief.quality.errors.push(result.code);
  if (loadScope(options.config, binding).digest !== policy.digest) {
    brief.ok = brief.quality.data_valid = false; brief.suggestions = [];
    brief.quality.errors.push('policy_changed_during_read'); brief.next_step = '重新读取本场策略和数据';
  }
  return { brief, raw: { binding, policy_digest: policy.digest, summary, list }, policy: policy.projected };
}
if (require.main === module) (async () => {
  const args = process.argv.slice(2), values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--account-id','--primary-ad-id','--room-id','--start-time','--config','--url','--output-dir','--format'].includes(args[i]) || !args[i + 1]) throw failure('invalid_arguments');
    values[args[i].slice(2)] = args[i + 1];
  }
  for (const key of ['account-id','primary-ad-id','room-id','start-time','config','url','output-dir']) if (!values[key]) throw failure(`required:${key}`);
  const format = values.format || 'json';
  if (!['json', 'heartbeat'].includes(format)) throw failure('invalid_format');
  if (!Number.isFinite(time(values['start-time']))) throw failure('invalid_start_time');
  const binding = { account_id: values['account-id'], primary_ad_id: values['primary-ad-id'], room_id: values['room-id'], start_time: values['start-time'] };
  const result = await collectBrief({ binding, config: path.resolve(values.config), url: values.url });
  const directory = path.join(path.resolve(values['output-dir']), hash(binding).slice(0, 20));
  fs.mkdirSync(directory, { recursive: true });
  const stem = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const rawFile = path.join(directory, stem + '.raw.json');
  fs.writeFileSync(rawFile, JSON.stringify(result.raw), { flag: 'wx' });
  result.brief.evidence_file = rawFile;
  const briefFile = path.join(directory, stem + '.brief.json');
  fs.writeFileSync(briefFile, JSON.stringify(result.brief), { flag: 'wx' });
  console.log(format === 'heartbeat' ? formatHeartbeat(result.brief, briefFile) : JSON.stringify(result.brief));
  if (!result.brief.ok) process.exitCode = 2;
})().catch(error => {
  const code = typeof error.code === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(error.code) ? error.code : 'watch_brief_failed';
  console.log(JSON.stringify({ ok: false, code, advertising_writes: 0 })); process.exitCode = 1;
});
module.exports = { buildBrief, collectBrief, loadScope, time, formatHeartbeat };
