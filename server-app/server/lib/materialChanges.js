'use strict';

// Pure projection over collector frames. No network, strategy thresholds or ROI recomputation.
const { finiteNumber: n, timestamp } = require('./dataContract');
const { contentVersion } = require('./watchContract');
const FIELDS = { spend: 'stat_cost_for_roi2', payment_orders: 'total_pay_order_count_realtime_for_roi2',
  net_gmv: 'total_order_settle_amount_realtime_for_roi2_1h', net_roi: 'total_prepay_and_pay_settle_realtime_roi2_1h' };
const cell = c => n(c && typeof c === 'object' ? c.Value ?? c.value ?? c.ValueStr : c);
const dim = c => c?.ValueStr || c?.Value || null;
const round = v => v == null ? null : +v.toFixed(4);
const sum = xs => xs.length && xs.every(x => x != null) ? round(xs.reduce((a, b) => a + b, 0)) : null;
const pct = (a, b) => a != null && b > 0 ? round(a / b * 100) : null;
const semanticRow = row => ({
  object_key: row?.object_key || null, material_id: row?.material_id || null,
  kind: row?.kind || null, object_type: row?.object_type || null, name: row?.name || null,
  status: row?.status || null, spend: row?.spend ?? null, payment_orders: row?.payment_orders ?? null,
  net_gmv: row?.net_gmv ?? null, net_roi: row?.net_roi ?? null,
  net_orders: row?.net_orders ?? null, missing_fields: row?.missing_fields || [], identity_valid: row?.identity_valid === true,
});
const semanticVersion = row => contentVersion(semanticRow(row));

function materialFrame(board, room, sessionKey) {
  const groups = {}, rows = [];
  for (const kind of ['video', 'live', 'carousel']) {
    const m = board.materials?.[kind];
    const sourceAt = timestamp(m?.source_at);
    const sourceRows = Array.isArray(m?.rows) ? m.rows : [];
    const filters = m?.scope_filters || null;
    const querySignature = contentVersion({ scope: m?.scope || 'unknown', filters });
    groups[kind] = { source_at: sourceAt, collected_at: timestamp(m?.collected_at),
      timestamp_basis: m?.timestamp_basis || 'unknown', window: m?.window || null,
      scope: m?.scope || 'unknown', data_valid: !!m && !m.error && !!sourceAt,
      total_spend: cell(m?.totals?.stat_cost_for_roi2), returned: sourceRows.length,
      total_count: n(m?.total_count), page: m?.page || null,
      filters, query_signature: querySignature, error: m?.code || (m?.error ? 'module_failed' : null) };
    for (let i = 0; i < sourceRows.length; i++) {
      const r = sourceRows[i], d = r.Dimensions || {}, metrics = r.Metrics || {};
      const id = dim(d.material_id), roomId = dim(d.room_id) || room.roomId || room.room_id;
      const objectKey = kind === 'live' ? `live:${roomId}:${dim(d.anchor_id) || ''}` : `${kind}:${id || `missing-${i}`}`;
      const values = Object.fromEntries(Object.entries(FIELDS).map(([k, field]) => [k, cell(metrics[field])]));
      rows.push({ object_key: objectKey, material_id: id == null ? null : String(id), kind,
        object_type: kind === 'live' ? 'live_picture' : /^\d+$/.test(String(id)) ? 'material' : 'aggregate_or_unresolved',
        name: dim(d[{ video: 'roi2_material_video_name', live: 'room_name', carousel: 'roi2_material_image_agg_name' }[kind]]) || id || kind,
        status: dim(d.roi2_material_status), ...values,
        net_orders: null, missing_fields: [...Object.keys(values).filter(k => values[k] == null), 'net_orders'],
        source_at: sourceAt, query_window: groups[kind].window, scope: groups[kind].scope,
        query_signature: querySignature,
        identity_valid: kind === 'live' ? !!roomId : !!id });
    }
  }
  return { session_key: sessionKey, groups, rows,
    source_at: Object.values(groups).map(g => g.source_at).filter(Boolean).sort()[0] || null };
}

function baseline(frames, at, minutes = 15) {
  const target = Date.parse(at) - minutes * 60000;
  // Never call a few seconds of data a 15m window. Actual endpoints are always returned.
  return frames.filter(f => Number.isFinite(Date.parse(f.source_at)) && Math.abs(Date.parse(f.source_at) - target) <= 5 * 60000)
    .sort((a, b) => Math.abs(Date.parse(a.source_at) - target) - Math.abs(Date.parse(b.source_at) - target))[0] || null;
}

function deltaValues(current, previous, fields = ['spend', 'payment_orders', 'net_gmv']) {
  const minutes = (Date.parse(current?.source_at) - Date.parse(previous?.source_at)) / 60000;
  let reason = !previous ? 'baseline_missing' : !current ? 'not_observed' : !Number.isFinite(minutes) || minutes <= 0 ? 'no_new_sample'
    : current.scope === 'unknown' || current.scope !== previous.scope || current.query_window?.start !== previous.query_window?.start
      || current.query_signature && previous.query_signature && current.query_signature !== previous.query_signature ? 'scope_changed' : null;
  const values = Object.fromEntries(fields.map(k => [k, reason || n(current?.[k]) == null || n(previous?.[k]) == null ? null : round(current[k] - previous[k])]));
  if (values.spend < 0) { reason = 'counter_reset_or_revision'; for (const k of fields) values[k] = null; }
  return { method: 'snapshot_difference', window: { start: previous?.source_at || null, end: current?.source_at || null, minutes: Number.isFinite(minutes) ? round(minutes) : null },
    data_valid: !reason && values.spend != null, reason, ...values,
    spend_per_hour: !reason && values.spend != null ? round(values.spend * 60 / minutes) : null,
    attribution: 'observed_change_not_cohort_conversion',
    correction_possible: values.net_gmv < 0 || values.payment_orders < 0,
    missing_fields: fields.filter(k => values[k] == null) };
}

class MaterialChanges {
  constructor() { this.accounts = new Map(); }
  clear(account) { this.accounts.delete(account); }
  ingest(account, frame) {
    if (!frame?.source_at || !frame.session_key) return;
    let state = this.accounts.get(account);
    if (!state || state.session !== frame.session_key) state = { session: frame.session_key, frames: [], known: new Map() };
    const last = state.frames.at(-1);
    if (last && Date.parse(frame.source_at) < Date.parse(last.source_at)) return;
    const signature = contentVersion(frame);
    if (last?.signature === signature) return;
    if (last?.source_at === frame.source_at) state.frames.pop();
    state.frames.push({ ...frame, signature });
    state.frames = state.frames.filter(f => Date.parse(f.source_at) >= Date.parse(frame.source_at) - 90 * 60000).slice(-240);
    for (const row of frame.rows || []) state.known.set(row.object_key, row);
    this.accounts.delete(account); this.accounts.set(account, state);
    while (this.accounts.size > 50) this.accounts.delete(this.accounts.keys().next().value);
  }
  build(account, { sessionKey, boosts = [], pending = [], alerts = [], now = Date.now(), limit = 10 } = {}) {
    const state = this.accounts.get(account), frame = state?.session === sessionKey ? state.frames.at(-1) : null;
    const base = frame && baseline(state.frames.slice(0, -1), frame.source_at);
    const earlier = base && baseline(state.frames, base.source_at);
    const previous = frame && state.frames.at(-2);
    const pendingKeys = new Set(pending.map(x => x.object_key || `${x.kind || 'video'}:${x.material_id}`));
    const alertKeys = new Set(alerts.filter(a => a.material_id || a.target_type === 'material').map(a => a.object_key || `video:${a.material_id || a.target_id}`));
    const byKey = f => new Map((f?.rows || []).map(r => [r.object_key, r]));
    const baseRows = byKey(base), olderRows = byKey(earlier), priorRows = byKey(previous);
    const currentRows = byKey(frame);
    const result = (frame?.rows || []).map(row => {
      const recent = deltaValues(row, baseRows.get(row.object_key));
      const prior = deltaValues(baseRows.get(row.object_key), olderRows.get(row.object_key));
      const ageMs = row.source_at ? now - Date.parse(row.source_at) : null;
      const reasons = [];
      if (pendingKeys.has(row.object_key)) reasons.push('pending_confirmation');
      if (alertKeys.has(row.object_key)) reasons.push('object_alert');
      if (recent.correction_possible || recent.reason === 'counter_reset_or_revision') reasons.push('metric_revision');
      if (recent.data_valid && recent.spend > 0 && recent.payment_orders === 0) reasons.push('spend_without_payment_order_increment');
      if (recent.net_gmv !== null && recent.net_gmv !== 0) reasons.push('net_gmv_changed');
      if (prior.data_valid && recent.data_valid && (recent.spend_per_hour !== prior.spend_per_hour || recent.payment_orders !== prior.payment_orders)) reasons.push('window_changed');
      const linked = boosts.filter(t => (t.material_ids || [t.material_id]).some(id => id != null && String(id) === row.material_id));
      return { ...row, recent, previous_window: prior.data_valid ? prior : null,
        spend_share_pct: pct(row.spend, frame.groups[row.kind]?.total_spend), spend_share_basis: 'same_module_cumulative_total',
        boost_ids: linked.map(t => String(t.id)), boost_attribution: 'not_allocated',
        boost_link_coverage: boosts.every(t => t.material_link_complete === true) ? 'complete' : 'partial',
        data_valid: ageMs != null && ageMs >= 0 && ageMs <= 90000 && row.identity_valid && row.spend != null,
        freshness: ageMs == null ? 'unavailable' : ageMs > 90000 ? 'stale' : 'fresh',
        reasons, changed_since_previous_sample: !priorRows.has(row.object_key) ? null : semanticVersion(row) !== semanticVersion(priorRows.get(row.object_key)) };
    });
    // Primary list only is capped. Exceptions and explicit follow-ups are never top-N filtered.
    const recentAvailable = !!base && result.some(r => r.recent.data_valid);
    const rank = [...result].sort((a, b) => (recentAvailable ? (b.recent.spend ?? -Infinity) - (a.recent.spend ?? -Infinity) : (b.spend ?? -Infinity) - (a.spend ?? -Infinity)) || a.object_key.localeCompare(b.object_key));
    const top = rank.slice(0, limit), chosen = new Set(top.map(r => r.object_key));
    const extra = result.filter(r => !chosen.has(r.object_key) && r.reasons.length);
    // Once observed objects may leave the upstream first page. Keep an explicit unknown, not a false zero/end.
    const absent = [];
    const retained = new Map(state?.session === sessionKey ? state.known : []);
    for (const p of pending) {
      const key = p.object_key || `${p.kind || 'video'}:${p.material_id}`;
      if (!retained.has(key)) retained.set(key, { object_key: key, material_id: p.material_id || null, kind: p.kind || 'video' });
    }
    for (const a of alerts) {
      const key = a.object_key || (a.material_id != null ? `video:${a.material_id}` : a.target_id != null ? `video:${a.target_id}` : null);
      if (key && !retained.has(key)) retained.set(key, { object_key: key, material_id: a.material_id || a.target_id || null, kind: a.kind || 'video', name: a.name || null });
    }
    for (const [key, old] of retained) {
      if (currentRows.has(key)) continue;
      absent.push({ object_key: key, material_id: old.material_id, kind: old.kind, name: old.name || null,
        data_valid: false, spend: null, payment_orders: null, net_gmv: null, net_roi: null,
        reason: !frame ? 'collector_unavailable_or_session_changed' : 'not_in_collected_page_not_proof_of_stop',
        pending_confirmation: pendingKeys.has(key), last_observed: old.source_at ? { source_at: old.source_at, spend: old.spend, payment_orders: old.payment_orders, net_gmv: old.net_gmv } : null });
    }
    const groupCoverage = Object.entries(frame?.groups || {}).map(([kind, g]) => {
      const observed = result.filter(r => r.kind === kind), selected = [...top, ...extra].filter(r => r.kind === kind);
      const spend = observed.length ? sum(observed.map(r => r.spend)) : g.returned === 0 && g.data_valid ? 0 : null;
      const selectedSpend = selected.length ? sum(selected.map(r => r.spend)) : 0;
      const gap = g.total_spend != null && spend != null ? round(g.total_spend - spend) : null;
      return { kind, ...g, observed_spend: spend, shown_spend: selectedSpend,
        coverage_pct: gap != null && gap >= -0.01 ? pct(spend, g.total_spend) : null,
        outside_collected_spend: gap != null && gap >= 0 ? gap : null,
        outside_shown_spend: g.total_spend != null && g.total_spend >= selectedSpend ? round(g.total_spend - selectedSpend) : null,
        reason: gap == null ? 'total_or_rows_missing' : gap < -0.01 ? 'rows_total_mismatch' : gap > 0.01 ? 'upstream_page_partial' : null };
    });
    return { source: 'collector_material_modules', session_key: sessionKey || null, source_at: frame?.source_at || null,
      value_basis: { spend: 'platform_cumulative', payment_orders: 'payment', net_orders: 'not_returned', net_gmv: 'platform_net_1h', net_roi: 'platform_net_1h_original' },
      ranking: recentAvailable ? 'observed_snapshot_window_spend' : 'collected_cumulative_spend', requested_window_minutes: 15,
      window_reason: recentAvailable ? null : 'insufficient_comparable_window', main_limit: limit,
      top, exceptions: extra, not_observed: absent, coverage: { groups: groupCoverage,
        observed_objects: result.length, shown_objects: top.length + extra.length, unobserved_retained: absent.length,
        room_spend_coverage_pct: null, room_coverage_reason: 'module_filters_and_source_times_differ_from_room_total',
        recent_coverage_pct: null, recent_coverage_reason: 'ranked_pages_not_complete_window_population' },
      missing_components: !frame ? ['material_collector_frame'] : [],
      follow_up: { tool: 'get_material', mode: 'detail', note: '仅对缺失对象定点补读；该接口的日/历史数据不替代本场窗口。' } };
  }
}

module.exports = { MaterialChanges, materialFrame, baseline, deltaValues };
