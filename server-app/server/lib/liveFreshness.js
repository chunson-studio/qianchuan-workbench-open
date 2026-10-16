'use strict';
const { normalizeFunnel, normalizeChannels } = require('./decisionContext');

const stamp = value => { const n = Date.parse(value); return Number.isFinite(n) ? n : -Infinity; };
const freshness = (value, now) => {
  const at = stamp(value);
  if (!Number.isFinite(at) || at === -Infinity) return { value: 'unavailable', age_ms: null };
  const age_ms = now - at;
  return { value: age_ms < 0 ? 'future' : age_ms > 90000 ? 'stale' : 'fresh', age_ms };
};

function refreshBoostTasks(tasks, now) {
  if (!Array.isArray(tasks)) return tasks;
  return tasks.map(task => {
    const out = { ...task };
    out.parameters_freshness = freshness(out.parameters_source_at, now);
    // Task report totals are known to be delayed upstream. A fresh HTTP fetch is
    // not evidence that their metrics describe the current live moment.
    out.metrics_freshness = out.metrics_freshness_override || freshness(out.metrics_source_at, now);
    if (out.realtime_detail) {
      const detail = { ...out.realtime_detail };
      detail.collected_age_ms = freshness(detail.collected_at, now).age_ms;
      detail.source_freshness = freshness(detail.source_at, now);
      out.realtime_detail = detail;
      out.realtime_detail_freshness = detail.source_freshness.value === 'fresh'
        ? (detail.financial_group_complete ? 'fresh_separate_detail' : 'partial_detail')
        : detail.source_freshness.value === 'unavailable' ? 'source_time_unavailable'
          : `source_${detail.source_freshness.value}`;
    }
    const missing = new Set((out.missing_fields || []).filter(key => !['parameters_source_stale', 'metrics_source_stale', 'recent_window'].includes(key)));
    if (['stale', 'future', 'unknown', 'unavailable'].includes(out.parameters_freshness.value)) missing.add('parameters_source_stale');
    if (['stale', 'future', 'unknown', 'unavailable'].includes(out.metrics_freshness.value)) {
      missing.add('metrics_source_stale');
      out.recent_changes = { ...(out.recent_changes || {}), data_valid: false, reason: 'metrics_not_current_live_evidence' };
    }
    if (!out.recent_changes?.data_valid) missing.add('recent_window');
    out.missing_fields = [...missing];
    out.audit_ready = out.missing_fields.length === 0;
    return out;
  });
}

function componentTimes(board) {
  const parts = { core: board.metrics, trend: board.trend, funnel: board.funnel, channels: board.channels,
    material_video: board.materials?.video, material_live: board.materials?.live, material_carousel: board.materials?.carousel };
  return Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, {
    source_at: part ? part.source_at || board.fetched_at || null : null,
    collected_at: part?.collected_at || null,
    timestamp_basis: part?.timestamp_basis || 'unknown',
    window: part?.window || null,
    dataValid: !!part && !part.error && Array.isArray(part.rows) && (name !== 'core' || part.rows.length > 0),
  }]));
}

// 新核心 + 原有慢模块，绝不把旧追投累计和新总消耗拼成拆分。
function mergeCoreRecord(latest, core, live) {
  if (!core?.record || !latest?.record || core.sessionKey !== latest.record.session_key) return latest;
  if (live?.isLive !== true || String(live.roomId) !== String(core.record.room.room_id)
      || String(live.startTime) !== String(core.record.room.start_time)) return latest;
  const oldAt = latest.record.component_times?.core?.source_at || latest.fetchedAt;
  if (stamp(core.fetchedAt) <= stamp(oldAt)) return latest;
  return { ...latest, fetchedAt: core.fetchedAt, record: { ...latest.record,
    collecting: false, live_metrics: core.record.live_metrics, dataValid: core.record.dataValid,
    component_times: { ...latest.record.component_times, core: core.record.component_times.core },
  } };
}

// 缓存保留慢模块，但每次响应重新读取核心及状态，年龄按真实采集时间重算。
function refreshDashboardCore(payload, watch, now = Date.now()) {
  const out = { ...payload, server_time: new Date(now).toISOString() };
  out.boost_tasks = refreshBoostTasks(payload.boost_tasks, now);
  if (watch?.session_key && watch.session_key === payload.session_key) {
    out.live = { ...payload.live, isLive: watch.isLive };
    out.liveCheckedAt = watch.liveCheckedAt || null;
    out.status_stale = watch.status_stale === true;
    for (const name of ['funnel', 'channels']) {
      const time = watch.component_times?.[name];
      if (time?.source_at && stamp(time.source_at) >= stamp(payload.component_times?.[name]?.source_at)) {
        const normalize = name === 'funnel' ? normalizeFunnel : normalizeChannels;
        out[name] = normalize(watch[name], { sourceAt: time.source_at, window: 'current_session',
          baseline: payload.decision_context?.[name === 'funnel' ? 'funnel_baseline' : 'channel_baseline'] });
        if (name === 'channels') out.source = watch.source || [];
        out.component_times = { ...out.component_times, [name]: time };
      }
    }
    if (stamp(watch.fetchedAt) >= stamp(payload.fetchedAt)) {
      out.fetchedAt = watch.fetchedAt || null;
      out.live_metrics = watch.live_metrics || null;
      out.dataValid = watch.dataValid === true;
      out.collecting = watch.collecting === true;
      out.component_times = { ...out.component_times, core: watch.component_times?.core || payload.component_times?.core || null };
      const m = watch.live_metrics;
      if (watch.isLive === true) {
        out.today = watch.dataValid === true && m ? {
          cost: m.cost ?? null, gmv: m.gmv ?? null, roi: m.roi ?? null,
          netGmv: m.gmvSettle ?? null, netRoi: m.roiSettle ?? null,
          orderCount: m.orders ?? null, orderCountPay: m.ordersPay ?? null,
          roi_basis: { roi: 'payment', netRoi: 'platform_net_1h' }, settlement_window: '1h',
        } : null;
        out.today_source = 'live_board';
      }
      if (out.live?.rooms) out.live = { ...out.live, rooms: out.live.rooms.map(r => ({ ...r, cost: m?.cost ?? null })) };
    }
    out.partial = out.partial === true || watch.partial === true;
    out.errors = [...(out.errors || []), ...(watch.errors || [])]
      .filter((e, i, a) => a.findIndex(x => JSON.stringify(x) === JSON.stringify(e)) === i);
  }
  out.age_ms = Number.isFinite(stamp(out.fetchedAt)) ? Math.max(0, now - stamp(out.fetchedAt)) : null;
  out.data_stale = out.live?.isLive === true && (out.age_ms == null || out.age_ms > 30000);
  out.stale = out.status_stale === true || out.data_stale;
  return out;
}

module.exports = { componentTimes, mergeCoreRecord, refreshDashboardCore, refreshBoostTasks };
