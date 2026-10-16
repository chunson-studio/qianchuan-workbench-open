// Local data reduction only. No browser access, advertising decisions or writes.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { reconcileFeedback } from './codex-qc-feedback.mjs';

// Reuse the shared metric arithmetic locally; importing this contract
// does not start a service, fetch data, or make an advertising API call.
const { diffMetrics } = createRequire(import.meta.url)('../server-app/server/lib/dataContract.js');
export const BRIEF_VERSION = '20261006-1';

// Model-facing output only; retain the original result for actions and readback.
export function compactControlResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('control_result_required');
  const out = structuredClone(result);
  delete out.display;
  const brief = out.brief;
  if (!brief || typeof brief !== 'object') return out;
  delete brief.goal;
  const tasks = brief.tasks;
  if (Array.isArray(tasks?.columns)) {
    const omitted = new Set(['impressions', 'clicks']);
    const indexes = tasks.columns.flatMap((key, index) => omitted.has(key) ? [] : [index]);
    // Malformed tables stay intact for diagnosis.
    if (['active', 'paused'].every(pool => Array.isArray(tasks[pool]) && tasks[pool].every(row => Array.isArray(row) && row.length === tasks.columns.length))) {
      tasks.columns = indexes.map(index => tasks.columns[index]);
      for (const pool of ['active', 'paused']) tasks[pool] = tasks[pool].map(row => indexes.map(index => row[index]));
    }
  }
  // Omit only identical copies; differing evidence remains visible.
  for (const key of ['binding', 'unresolved', 'actions', 'scene_isolation']) {
    if (Object.hasOwn(out, key) && Object.hasOwn(brief, key) && JSON.stringify(out[key]) === JSON.stringify(brief[key])) delete brief[key];
  }
  if (out.rules?.model_review) {
    for (const [key, nested] of [['zero_order_review_candidates', 'zero_order_review_candidates'], ['budget_unknown', 'budget_unknown']]) {
      if (Object.hasOwn(out.rules, key) && JSON.stringify(out.rules[key]) === JSON.stringify(out.rules.model_review[nested])) delete out.rules[key];
    }
  }
  // Group repeated scope descriptions without dropping IDs, owners or reasons.
  const coverage=brief.management_coverage;
  if(coverage&&typeof coverage==='object')for(const key of ['managed','protected','uncovered']) {
    const records=coverage[key];
    if(!Array.isArray(records)||records.length<2||records.some(r=>!r||typeof r!=='object'||Array.isArray(r)||typeof r.task_id!=='string'))continue;
    const groups=new Map();
    for(const record of records) {
      const {task_id,...details}=record,groupKey=JSON.stringify(details);
      if(!groups.has(groupKey))groups.set(groupKey,{details,task_ids:[]});
      groups.get(groupKey).task_ids.push(task_id);
    }
    const grouped={grouped_by:'details',groups:[...groups.values()]};
    if(JSON.stringify(grouped).length<JSON.stringify(records).length)coverage[key]=grouped;
  }
  return out;
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
const number = v => {
  if (finite(v)) return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[,，¥￥]/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
};
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const round = v => finite(v) ? Math.round(v * 1e6) / 1e6 : null;
const delta = (a, b) => finite(a) && finite(b) ? (diffMetrics({ value: b }, { value: a }, ['value'])[0]?.delta ?? 0) : null;
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const sameBinding = (a, b) => ['advertiser_id', 'primary_ad_id', 'room_id', 'date'].every(k => a?.[k] != null && a[k] === b?.[k])
  && (a?.session_started_at ?? null) === (b?.session_started_at ?? null);
const headerKey = s => String(s).replace(/\s|[()（）]/g, '').replace(/小时|元/g, '');
// Explicit *_pct values are percentage points, never guessed fractions.
const percent = v => {
  const n = number(typeof v === 'string' ? v.trim().replace(/[%％]$/, '') : v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};
const count = v => { const n = number(v); return Number.isInteger(n) && n >= 0 ? n : null; };
const fields = {
  name: ['任务名称'], status: ['调控状态'], budget: ['调控预算', '预算'], duration_hours: ['调控时长'],
  created_at: ['创建时间'],
  cost: ['调控消耗', '消耗'], payment_orders: ['调控成交订单数'], payment_gmv: ['调控成交金额'],
  payment_roi: ['调控支付ROI'], net_gmv: ['调控净成交金额'], displayed_net_roi: ['调控净成交ROI'],
  ctr_pct: ['调控点击率'], conversion_rate_pct: ['调控转化率'],
  impressions: ['调控展示次数', '调控展现次数', '调控曝光次数'], clicks: ['调控点击次数'],
};

export function cleanTaskPool(input = {}, expectedFilter) {
  if (!['手动暂停', '调控中', '全部（包括已删除）'].includes(expectedFilter)) throw new Error('Unsupported task filter');
  const issues = [], tasks = [];
  const filter = input.actual_filter ?? input.filter ?? input.pool ?? null;
  if (filter !== expectedFilter) issues.push({ code: 'filter_not_verified', actual: filter, expected: expectedFilter });
  // Older callers retain raw rows but supply normalized tasks with rates omitted.
  // Recover only matching IDs and states from this same pool, never by row position.
  const headers = Array.isArray(input.headers) ? input.headers.map(headerKey) : [];
  const positions = Object.fromEntries(Object.entries(fields).map(([key, labels]) => [key,
    headers.findIndex(h => labels.some(label => headerKey(label) === h))]));
  const rowTasks = Array.isArray(input.rows) && positions.name >= 0 && positions.status >= 0
    ? input.rows.map(row => Object.fromEntries(Object.entries(positions)
      .filter(([, i]) => i >= 0).map(([key, i]) => [key, row[i]]))) : [];
  const rawById = new Map();
  for (const row of rowTasks) {
    const id = String(row.name ?? '').match(/ID\s*[:：]\s*(\d+)/i)?.[1];
    if (id) rawById.set(id, rawById.has(id) ? null : row);
  }
  let source = input.tasks;
  if (!Array.isArray(source)) {
    source = [];
    if (Array.isArray(input.rows)) {
      if (positions.name < 0 || positions.status < 0) issues.push({ code: 'task_headers_missing' });
      else source = rowTasks;
    } else issues.push({ code: 'task_rows_missing' });
  }
  const seen = new Set();
  for (const task of source) {
    const id = task.task_id ?? String(task.name ?? '').match(/ID\s*[:：]\s*(\d+)/i)?.[1];
    if (typeof id !== 'string' || !id.trim()) { issues.push({ code: 'task_id_not_string' }); continue; }
    if (seen.has(id)) { issues.push({ code: 'duplicate_task', id }); continue; }
    seen.add(id);
    const status_raw = String(task.status ?? '').trim();
    const status = /^调控中\s+保$/.test(status_raw)?'调控中':status_raw;
    const matches = expectedFilter === '全部（包括已删除）' ? Boolean(status) : expectedFilter === '调控中' ? status === '调控中'
      : /已暂停/.test(status) && /手动暂停/.test(status) && !/调控中/.test(status);
    if (!matches) { issues.push({ code: 'task_status_mismatch', id, status }); continue; }
    const clean = { task_id: id, status, status_raw, status_badges:status!==status_raw?['保']:[], name:String(task.name ?? '').split(/\n?ID\s*[:：]/)[0].trim() };
    const creation=String(task.created_at??'').trim().replace(/\s+/g,' ');
    clean.created_at=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(creation)?creation.replace(' ','T')+'+08:00':null;
    if(typeof task.created_at==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(task.created_at))clean.created_at=task.created_at;
    for (const key of ['cost', 'payment_orders', 'payment_gmv', 'payment_roi', 'net_gmv', 'displayed_net_roi', 'budget']) clean[key] = number(task[key]);
    const candidate = rawById.get(id);
    const raw = candidate && String(candidate.status ?? '').trim() === status_raw ? candidate : null;
    for (const key of ['ctr_pct', 'conversion_rate_pct']) clean[key] = percent(task[key] ?? raw?.[key]);
    for (const key of ['impressions', 'clicks']) clean[key] = count(task[key] ?? raw?.[key]);
    if (task.rate_source !== undefined) clean.rate_source = task.rate_source;
    const hours = task.duration_hours ?? task.duration;
    clean.duration_hours = number(hours);
    // Duration cells include a second line with an estimated end time.
    if (clean.duration_hours === null && typeof hours === 'string') clean.duration_hours = number(hours.split('\n')[0]);
    tasks.push(clean);
  }
  const total = number(input.total);
  if (total !== null && (!Number.isInteger(total) || total < 0 || total !== tasks.length)) issues.push({ code: 'pool_count_mismatch', total, read: tasks.length });
  if (tasks.length === 0 && input.complete === true && input.empty_verified !== true) issues.push({ code: 'empty_pool_needs_dom_proof' });
  if (input.error) issues.push({ code: 'pool_read_error', detail: input.error });
  return { filter, captured_at: input.captured_at ?? null, total, tasks, 
    complete: input.complete === true && issues.length === 0, issues };
}

const cols = ['id', 'cost', 'orders', 'gmv', 'payment_roi', 'net_gmv', 'net_roi', 'budget', 'hours', 'delta_cost', 'delta_orders', 'cost_per_minute', 'delta_gmv', 'delta_net_gmv', 'ctr_pct', 'conversion_rate_pct', 'impressions', 'clicks'];
const fiveTime = c => c?.five_minutes?.updated_at_text ?? c?.five_minutes?.updated_display ?? c?.five_minutes?.updated_at ?? null;
const live = c => {
  const state = ['live', 'ended', 'pre_live', 'unknown'].includes(c?.live_state) ? c.live_state : null;
  if (state === 'live' && c?.in_live === false || ['ended', 'pre_live'].includes(state) && c?.in_live === true) return 'unknown';
  // false alone can mean pre-live, a failed read or an ended scene. Never guess end.
  return state ?? (c?.in_live === true ? 'live' : 'unknown');
};
const windowTime = value => {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return time(value);
  const match = value.match(/^(\d{1,2}):(\d{2})(?:更新)?$/);
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? (Number(match[1]) * 60 + Number(match[2])) * 60000 : null;
};

export function calculateRoundDeltas(previous, current) {
  if (previous && !sameBinding(previous.binding, current.binding)) throw new Error('Cannot compare different scene bindings');
  if (time(current.captured_at) === null || previous && (time(previous.captured_at) === null || time(current.captured_at) <= time(previous.captured_at))) throw new Error('Capture time must advance');
  const c = current.compass ?? {}, old = previous?.compass ?? {};
  const sameScene = previous != null && c.room_id != null && c.room_id === current.binding?.room_id
    && old.room_id === c.room_id && c.live_start_display != null && old.live_start_display === c.live_start_display;
  const source = x => x.source_id ?? x.channel ?? x.source ?? null;
  const sameSource = sameScene && source(c) != null && source(c) === source(old) && (c.metric_basis ?? null) === (old.metric_basis ?? null);
  const newWindow = sameSource && windowTime(fiveTime(c)) !== null && windowTime(fiveTime(old)) !== null
    && windowTime(fiveTime(c)) > windowTime(fiveTime(old));
  const sameTopSnapshot = c.top_metric_source_time != null && c.top_metric_source_time === old.top_metric_source_time;
  const board = Object.fromEntries(['gmv', 'refund', 'cost', 'net_gmv'].map(k => [k, sameSource && !sameTopSnapshot ? delta(number(c[k]), number(old[k])) : null]));
  board.net_roi = sameSource && !sameTopSnapshot ? delta(number(c.net_roi), number(old.net_roi)) : null;
  board.incremental_net_roi = finite(board.net_gmv) && board.cost > 0 ? round(board.net_gmv / board.cost) : null;
  board.online_snapshot = newWindow ? delta(number(c.five_minutes?.online_snapshot), number(old.five_minutes?.online_snapshot)) : null;
  const a = cleanTaskPool(current.active_pool, '调控中'), p = cleanTaskPool(current.paused_pool, '手动暂停');
  const pa = previous ? cleanTaskPool(previous.active_pool, '调控中') : null, pp = previous ? cleanTaskPool(previous.paused_pool, '手动暂停') : null;
  const overlap = (x, y) => x.tasks.some(t => y.tasks.some(s => s.task_id === t.task_id));
  const complete = sameScene && a.complete && p.complete && pa?.complete === true && pp?.complete === true && !overlap(a, p) && !overlap(pa, pp);
  const prior = new Map((complete ? [...pa.tasks, ...pp.tasks] : []).map(t => [t.task_id, t]));
  const tasks = [...a.tasks, ...p.tasks].map(t => {
    const prev = prior.get(t.task_id), from = pa?.tasks.some(s => s.task_id === t.task_id) ? pa : pp;
    const to = a.tasks.some(s => s.task_id === t.task_id) ? a : p;
    const minutes = prev && time(from?.captured_at) !== null && time(to.captured_at) !== null ? (time(to.captured_at) - time(from.captured_at)) / 60000 : null;
    const compare = prev && minutes > 0;
    const dc = compare ? delta(t.cost, prev.cost) : null;
    return { task_id: t.task_id, cost_delta: dc, orders_delta: compare ? delta(t.payment_orders, prev.payment_orders) : null,
      payment_gmv_delta: compare ? delta(t.payment_gmv, prev.payment_gmv) : null,
      net_gmv_delta: compare ? delta(t.net_gmv, prev.net_gmv) : null, elapsed_minutes: round(minutes),
      displayed_cost_per_minute: dc !== null && dc >= 0 && minutes > 0 ? round(dc / minutes) : null };
  });
  return { board, tasks, comparison: { same_scene: sameScene, same_source: sameSource, pools_complete: complete,
    five_new_window: newWindow, top_comparable: sameSource && !sameTopSnapshot } };
}

export function buildDecisionBrief(previous, current, options = {}) {
  const binding = current?.binding;
  if (!binding || !['advertiser_id', 'primary_ad_id', 'room_id', 'date'].every(k => typeof binding[k] === 'string' && binding[k])) throw new Error('Explicit string scene binding required');
  if (previous && !sameBinding(previous.binding, binding)) throw new Error('Cannot compare different scene bindings');
  if (time(current.captured_at) === null) throw new Error('Capture time required');
  if (previous && (time(previous.captured_at) === null || time(current.captured_at) <= time(previous.captured_at))) throw new Error('Capture time must advance');
  const a = cleanTaskPool(current.active_pool, '调控中'), p = cleanTaskPool(current.paused_pool, '手动暂停');
  const issues = [...a.issues.map(i => ({ pool: 'active', ...i })), ...p.issues.map(i => ({ pool: 'paused', ...i }))];
  for (const t of a.tasks) if (p.tasks.some(s => s.task_id === t.task_id)) issues.push({ code: 'task_in_both_pools', id: t.task_id });
  const c = current.compass ?? {}, old = previous?.compass ?? {};
  const sceneMatches = c.room_id === binding.room_id && c.live_start_display != null;
  if (!sceneMatches) issues.push({ code: 'board_scene_unverified' });
  const liveState = sceneMatches ? live(c) : 'unknown';
  if (liveState === 'unknown') issues.push({ code: 'live_state_unknown' });
  const computed = calculateRoundDeltas(previous, current);
  const afterWindow = fiveTime(c), newWindow = computed.comparison.five_new_window;
  const gm = number(c.gmv), refund = number(c.refund), cost = number(c.cost);
  // net_roi is accepted only from the normalized reader's explicit same-scene value.
  // Do not derive it from mixed-source payment GMV, rounded task ROI, or missing refunds.
  const top = { gmv: gm, refund, cost, net_gmv: number(c.net_gmv), net_roi: number(c.net_roi),
    overall_cost:number(c.overall_cost),overall_roi:number(c.overall_roi),net_transaction_roi:number(c.net_transaction_roi) };
  const sourceTime = c.top_metric_source_time ?? null;
  const taskDeltas = new Map(computed.tasks.map(t => [t.task_id, t]));
  const rows = pool => pool.tasks.map(t => {
    const d = taskDeltas.get(t.task_id);
    const roi = t.payment_roi ?? (t.cost > 0 && finite(t.payment_gmv) ? round(t.payment_gmv / t.cost) : null);
    return [t.task_id, t.cost, t.payment_orders, t.payment_gmv, roi, t.net_gmv, t.displayed_net_roi,
      t.budget, t.duration_hours, d?.cost_delta ?? null, d?.orders_delta ?? null, d?.displayed_cost_per_minute ?? null,
      d?.payment_gmv_delta ?? null, d?.net_gmv_delta ?? null, t.ctr_pct, t.conversion_rate_pct, t.impressions, t.clicks];
  });
  const five = c.five_minutes ?? {};
  const now = options.now ?? current.captured_at, started = options.triggered_at ?? null;
  const elapsed = time(now) !== null && time(started) !== null ? (time(now) - time(started)) / 1000 : null;
  const interval = number(options.check_interval_seconds ?? current.check_interval_seconds);
  const delay = number(options.action_delay_seconds ?? current.action_delay_seconds);
  const remaining = elapsed !== null && interval > 0 ? round(interval - elapsed) : null;
  const nextAt = time(options.next_check_at ?? current.next_check_at);
  const nextSeconds = nextAt !== null && time(now) !== null ? Math.max(0, (nextAt - time(now)) / 1000)
    : interval > 0 ? Math.max(0, remaining ?? interval) : null;
  const feedback = reconcileFeedback(options.feedback_previous ?? previous, current, now);
  issues.push(...feedback.issues);
  const queue = feedback.pending.map(item => ({ ...pick(item, ['event_id', 'task_id', 'kind', 'action', 'feedback_until', 'deadline', 'baseline_cost', 'baseline_orders', 'baseline_gmv', 'due', 'overdue_seconds']) }));
  const budgetWatch = a.tasks.map(t => {
    const rate = taskDeltas.get(t.task_id)?.displayed_cost_per_minute ?? null;
    const left = t.budget > 0 && t.cost !== null && t.cost >= 0 ? round(t.budget - t.cost) : null;
    const age = time(a.captured_at) !== null && time(now) !== null && time(now) >= time(a.captured_at)
      ? (time(now) - time(a.captured_at)) / 1000 : null;
    const horizon = nextSeconds !== null && delay !== null && delay >= 0 && age !== null ? nextSeconds + delay + age : null;
    const runway = left !== null && left <= 0 ? 0 : left !== null && rate > 0 ? round(left / rate * 60) : null;
    return { task_id: t.task_id, budget: t.budget, cost: t.cost, remaining_yuan: left,
      used_pct: left !== null ? round(t.cost / t.budget * 100) : null,
      cost_per_minute: rate, runway_seconds_at_capture: runway, sampled_at: a.captured_at,
      required_seconds_at_capture: horizon,
      capacity_risk: !a.complete ? 'unknown' : left !== null && left <= 0 ? 'exhausted'
        : runway !== null && horizon !== null ? (runway <= horizon ? 'before_next_action' : 'covered_at_recent_rate') : 'unknown' };
  });
  const memory = Object.fromEntries(Object.entries(options.task_state ?? current.task_state ?? {}).map(([id, state]) => {
    const task = [...a.tasks, ...p.tasks].find(t => t.task_id === id);
    const result = pick(state, ['opportunity_yuan', 'zero_order_limit_yuan', 'opportunity_reason', 'last_order_growth_at', 'last_order_cost', 'last_order_orders', 'startup_baseline', 'recovery_baseline', 'parameter_baseline', 'watch_until']);
    const since = baseline => ({ cost: delta(task?.cost, number(baseline?.cost)), orders: delta(task?.payment_orders, number(baseline?.orders)), gmv: delta(task?.payment_gmv, number(baseline?.gmv)) });
    if (state.last_order_cost !== undefined) result.since_order_growth = since({ cost: state.last_order_cost, orders: state.last_order_orders });
    if (state.recovery_baseline) result.since_recovery = since(state.recovery_baseline);
    if (state.parameter_baseline) result.since_parameters = since(state.parameter_baseline);
    if (state.startup_baseline) result.since_startup = since(state.startup_baseline);
    return [id, result];
  }));
  const brief = {
    v: 1, binding: pick(binding, ['advertiser_id', 'primary_ad_id', 'room_id', 'date', 'session_started_at', 'live_start_display']),
    at: current.captured_at, phase: current.phase ?? liveState, live_state: liveState,
    live_state_evidence: { source: c.source_id ?? c.channel ?? c.source ?? null,
      observed_at: c.live_state_observed_at ?? c.captured_at ?? current.captured_at,
      basis: c.live_state_evidence ?? null },
    goal: options.policy ?? { target_net_roi: number(current.target_net_roi) },
    board: { ...top, delta: computed.board, source: c.source_id ?? c.channel ?? c.source ?? null, metric_basis: c.metric_basis ?? null,
      captured_at: c.captured_at ?? current.captured_at, updated_at: sourceTime, window: c.data_window ?? c.trend?.displayed_time_range ?? null,
      live_start: c.live_start_display ?? null },
    live_top: c.live_top ?? null,
    five: { updated_at: afterWindow, online_captured_at: c.live_top?.captured_at ?? null, new_window: newWindow, payment_gmv: number(five.payment_gmv ?? five.gmv),
      online: number(c.live_top?.realtime_online), online_snapshot: number(five.online_snapshot), enter: number(five.enters ?? five.enter), leave: number(five.leaves ?? five.leave),
      flow: five.flow ?? null, online_delta: computed.board.online_snapshot,
      ring: five.comparison ?? five.ring_changes ?? five.changes ?? null },
    trend: c.trend ? pick(c.trend, ['displayed_time_range', 'metrics_selected', 'selected_window', 'point_interval', 'summary', 'cost', 'online']) : null,
    tasks: { columns: cols, active: rows(a), paused: rows(p),
      identity: [...a.tasks,...p.tasks].map(t=>({task_id:t.task_id,name:t.name,created_at:t.created_at})),
      coverage: { active: a.complete, paused: p.complete }, sampled_at: [a.captured_at, p.captured_at],
      rate_basis: 'task control CTR/conversion, percentage points; missing samples are null' },
    task_state: memory, budget_watch: budgetWatch, pending: queue, external_changes: current.external_changes ?? [],
    actions: current.actions ?? [], unresolved: current.unresolved_submissions ?? current.retry_write ?? [],
    quality: { issues, warnings: budgetWatch.filter(w => w.capacity_risk === 'unknown').map(w => ({code:'budget_capacity_unknown', task_id:w.task_id})), missing: ['gmv','refund','cost','net_gmv','net_roi'].filter(k => top[k] === null), top_comparable: computed.comparison.top_comparable,
      write_ready: sceneMatches && liveState === 'live' && a.complete && p.complete && issues.length === 0 },
    timing: { check_interval_seconds: interval, action_delay_seconds: delay, action_delay_source: options.action_delay_source ?? null,
      elapsed_seconds: round(elapsed), remaining_seconds: remaining, slow: elapsed !== null && interval > 0 && elapsed > interval / 2,
      enough_for_new_write: remaining === null ? null : remaining >= (options.readback_reserve_seconds ?? 20) },
    evidence: options.evidence_path ?? current.evidence_dir ?? null,
  };
  return brief;
}

export async function saveDecisionBrief({ previous = null, current, file, ...options }) {
  const brief = buildDecisionBrief(previous, current, { ...options, evidence_path: options.evidence_path ?? file });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(brief), 'utf8');
  return brief;
}

// Bind the existing verified browser reader and evidence callback once in cua_repl.
// Raw data never needs to cross the model boundary. This does not perform UI actions itself.
export function createRoundBriefReader({ readCurrent, loadPrevious, retainCurrent, policy, task_state, check_interval_seconds, action_delay_seconds }) {
  if (![readCurrent, loadPrevious, retainCurrent].every(f => typeof f === 'function')) throw new Error('Verified capture, prior receipt and local evidence callbacks required');
  return async function readRoundBrief({ triggered_at, next_check_at } = {}) {
    const previous = await loadPrevious();
    const current = await readCurrent();
    const evidence_path = await retainCurrent(current);
    if (typeof evidence_path !== 'string' || !evidence_path) throw new Error('Complete local capture evidence must be retained before returning a brief');
    return buildDecisionBrief(previous, current, { policy,
      task_state: typeof task_state === 'function' ? await task_state() : task_state,
      triggered_at, next_check_at, check_interval_seconds, action_delay_seconds, now: new Date().toISOString(), evidence_path });
  };
}

// Use instead of printing saveRound(...).result; the full receipt is still retained locally.
export async function saveRoundBrief(args) {
  const { saveRound } = await import(`./codex-qc-round-record.mjs?brief=${BRIEF_VERSION}`);
  const saved = await saveRound(args);
  return { saved: true, at: saved.result.captured_at, actions: saved.result.actions,
    active: saved.result.active_pool?.tasks?.length ?? null, paused: saved.result.paused_pool?.tasks?.length ?? null,
    pending: saved.result.pending_queue?.length ?? null, full_round: saved.full_round, latest: saved.latest,
    ad_actions_performed: 0 };
}
