



const fs = require('fs');
const path = require('path');
const { sendJSON, getLocalDateStr } = require('../lib/utils');
const { getDB } = require('../lib/db');
const { aggregateFunnelRows, evaluateFunnel } = require('../lib/materialFunnel');
const { loadStableFunnelContext, shiftDate } = require('../lib/materialFunnelStore');
const { getLiveDynamicsShadow } = require('../lib/liveDynamicsShadow');
const { evaluateExpansionDilutionShadow } = require('../lib/expansionDilutionShadow');
const {
  buildExpansionDilutionEvidence,
  toLedgerEvaluation,
} = require('../lib/expansionDilutionEvidence');
const decisionLedger = require('../lib/decisionLedger');
const { loadAccountProfile } = require('../lib/accountProfile');
const { FLOW_CONTRACT, withFlowRole } = require('../lib/flowContract');

const MATERIAL_EVIDENCE_META = Object.freeze({
  family: 'Material Evidence',
  version: '1.0',
  window: 'intraday_5m_15m_30m_60m',
  selection_method: 'active_materials_by_spend_with_stable_content_funnel',
  scoring_enabled: false,
});

function materialEvidenceMeta(extra = {}) {
  return { ...MATERIAL_EVIDENCE_META, ...extra };
}
const { handleApiError } = require('../lib/handleApiError');
const { validateAccount, getAccountParams } = require('../lib/api-helpers');

const ROOT_DIR = path.join(__dirname, '..', '..');
const COMPASS_CACHE_DIR = path.join(ROOT_DIR, 'cache', 'compass');
const _cockpitCache = new Map();
const CACHE_TTL_MS = 15 * 1000;

function round(v, n = 2) {
  if (v == null || v === '') return null;
  return Number.isFinite(+v) ? +(+v).toFixed(n) : null;
}

function finiteMetric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLiveMetricState(liveMetrics = {}, options = {}) {
  const isLive = options.isLive === true;
  const collecting = options.collecting === true;
  const cost = finiteMetric(liveMetrics.cost);
  const netGmv = finiteMetric(liveMetrics.gmvSettle);
  const orders = finiteMetric(liveMetrics.orders);
  const payRoi = finiteMetric(liveMetrics.roi);
  const netRoi = finiteMetric(liveMetrics.roiSettle);
  const online = finiteMetric(liveMetrics.online);
  const gpm = finiteMetric(liveMetrics.gpm);
  const strictNetAvailable = isLive && !collecting && liveMetrics.netDataValid === true &&
    liveMetrics.costDataValid === true && cost != null && netGmv != null;
  return {
    strictNetAvailable,
    spend: strictNetAvailable ? cost : null,
    netGmv: strictNetAvailable ? netGmv : null,
    orders: strictNetAvailable && orders != null ? orders : null,
    payRoi: isLive && payRoi != null ? payRoi : null,
    netRoi: isLive && !collecting && liveMetrics.netDataValid === true ? netRoi : null,
    online: isLive && online != null ? online : null,
    gpm: isLive && gpm != null ? gpm : null,
  };
}

function queryValue(source, key, fallback = null) {
  if (!source) return fallback;
  if (source.searchParams && typeof source.searchParams.get === 'function') {
    const v = source.searchParams.get(key);
    return v == null ? fallback : v;
  }
  if (typeof source.get === 'function') {
    const v = source.get(key);
    return v == null ? fallback : v;
  }
  return source[key] == null ? fallback : source[key];
}

function parseBool(v, fallback = false) {
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function parseTimeMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = +v;
    return n < 1e12 ? n * 1000 : n;
  }
  const s = String(v).trim();
  const localMatch = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/);
  const normalized = localMatch
    ? `${localMatch[1]}T${localMatch[2]}+08:00`
    : s;
  return new Date(normalized).getTime();
}

function persistExpansionDilutionEvidence() { return {failed:false,ref:{persisted:false,forward_evaluable:false,status:'not_included'}}; }

function isPrimaryCockpitDataDegraded(input = {}) {
  const {
    collectorError,
    liveStateError,
    collectorStale,
    roomConflict,
    isLive,
    strictNetAvailable,
    planControlUsable,
    marginalM15Quality,
  } = input;
  
  
  return !!(
    collectorError || liveStateError || collectorStale || roomConflict ||
    (isLive && !strictNetAvailable) ||
    (isLive && !planControlUsable) ||
    (isLive && !['complete', 'partial'].includes(marginalM15Quality))
  );
}

function getCockpitConfig(accountId) { const p=getAccountParams(accountId);return {break_even_roi:p.break_even_roi??null,profit_roi:null,floor_roi:null,flow_benchmark:null,flow_low:null,flow_high:null,marginal_stale_seconds:720,material_stale_seconds:720,collector_stale_seconds:120,roi_lock_minutes:0,calibrated:false,source:'user_config_only'}; }

function getAccountMode() { return 'agent_decides'; }

function emptyMarginal(minutes, status, source = 'live_collector.trend') {
  return {
    window_minutes: minutes,
    actual_window_minutes: 0,
    delta_spend: null,
    delta_net_gmv: null,
    delta_orders: null,
    spend_rate_hour: null,
    total_spend_rate_hour: null,
    basic_spend_rate_hour: null,
    assist_spend_rate_hour: null,
    delta_basic_spend: null,
    delta_assist_spend: null,
    assist_share_pct: null,
    flow_split_quality: status,
    flow_split_actual_minutes: 0,
    flow_split_source: null,
    marginal_net_roi: null,
    trend: 'unavailable',
    as_of: null,
    freshness_seconds: null,
    stale: status === 'stale',
    data_quality: status,
    source,
  };
}


function buildMarginalSliceFromTrend(trend, minutes, opts = {}) {
  const allowed = [5, 15, 30, 60];
  if (!allowed.includes(minutes)) return { ...emptyMarginal(minutes, 'unavailable'), error: 'minutes 仅支持 5/15/30/60' };
  if (opts.isLive !== true) return emptyMarginal(minutes, 'offline');

  const nowMs = Number.isFinite(+opts.nowMs) ? +opts.nowMs : Date.now();
  const maxAgeSec = Number.isFinite(+opts.maxAgeSec) ? +opts.maxAgeSec : 720;
  const rows = (Array.isArray(trend) ? trend : []).map(rawPoint => {
    const p = rawPoint && typeof rawPoint === 'object' ? rawPoint : {};
    return {
      ts: parseTimeMs(p.time || p.point_time || p.as_of),
      time: p.time || p.point_time || p.as_of,
      cost: finiteMetric(p.cost ?? p.delta_spend),
      net: finiteMetric(p.gmvSettle ?? p.net_1h ?? p.delta_net_gmv),
      
      
      sourceValid: p.netDataValid !== false && p.costDataValid !== false,
    };
  }).filter(p => Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);

  if (!rows.length) return emptyMarginal(minutes, 'unavailable');

  
  
  
  const bucketMs = 5 * 60000;
  const sourceAsOfMs = parseTimeMs(opts.sourceAsOfMs ?? opts.sourceAsOf);
  const closedCutoffMs = Number.isFinite(sourceAsOfMs) ? Math.min(nowMs, sourceAsOfMs) : nowMs;
  const closedRows = rows.filter(p => p.ts + bucketMs <= closedCutoffMs);
  if (!closedRows.length) {
    const current = rows[rows.length - 1];
    if (rows.some(p => !p.sourceValid || p.cost == null || p.net == null)) {
      return {
        ...emptyMarginal(minutes, 'unavailable'),
        as_of: current.time,
        freshness_seconds: Math.max(0, Math.round((nowMs - current.ts) / 1000)),
        error: 'source_metric_missing',
      };
    }
    return {
      ...emptyMarginal(minutes, 'collecting'),
      as_of: current.time,
      freshness_seconds: Math.max(0, Math.round((nowMs - current.ts) / 1000)),
      error: 'latest_bucket_not_closed',
    };
  }
  const latest = closedRows[closedRows.length - 1];
  const freshnessSec = Math.max(0, Math.round((nowMs - (latest.ts + bucketMs)) / 1000));
  if (freshnessSec > maxAgeSec) {
    return {
      ...emptyMarginal(minutes, 'stale'),
      as_of: latest.time,
      freshness_seconds: freshnessSec,
    };
  }

  const expectedPoints = Math.ceil(minutes / 5);
  const selected = closedRows.slice(-expectedPoints);
  if (selected.some(p => !p.sourceValid || p.cost == null || p.net == null)) {
    return {
      ...emptyMarginal(minutes, 'unavailable'),
      as_of: latest.time,
      freshness_seconds: freshnessSec,
      error: 'source_metric_missing',
    };
  }
  let contiguous = true;
  for (let i = 1; i < selected.length; i++) {
    const gapMs = selected[i].ts - selected[i - 1].ts;
    if (Math.abs(gapMs - bucketMs) > 5000) contiguous = false;
  }
  const actualMinutes = selected.length * 5;
  const deltaSpend = selected.reduce((s, p) => s + Math.max(0, p.cost), 0);
  const deltaNet = selected.reduce((s, p) => s + p.net, 0);
  const roi = deltaSpend > 0 ? deltaNet / deltaSpend : null;
  const rate = actualMinutes > 0 ? deltaSpend * 60 / actualMinutes : null;
  const flowLow = Number.isFinite(+opts.flowLow) ? +opts.flowLow : 200;
  const flowHigh = Number.isFinite(+opts.flowHigh) ? +opts.flowHigh : 400;
  const trendName = rate == null ? 'unavailable' : (rate > flowHigh ? 'up' : (rate < flowLow ? 'down' : 'flat'));
  const quality = selected.length === expectedPoints && contiguous ? 'complete' : 'partial';

  return {
    window_minutes: minutes,
    actual_window_minutes: actualMinutes,
    delta_spend: round(deltaSpend),
    delta_net_gmv: round(deltaNet),
    delta_orders: null,
    spend_rate_hour: round(rate),
    marginal_net_roi: round(roi),
    trend: trendName,
    as_of: latest.time,
    freshness_seconds: freshnessSec,
    stale: false,
    data_quality: quality,
    source: 'live_collector.trend',
    net_data_valid: true,
  };
}

function roomIdOf(room) {
  return room && (room.room_id != null || room.roomId != null)
    ? String(room.room_id != null ? room.room_id : room.roomId)
    : '';
}

function hasRoomConflict(watch, trendInfo) {
  if (!(watch && watch.isLive)) return false;
  const detected = watch.detectedRoomId != null ? String(watch.detectedRoomId) : '';
  const record = roomIdOf(watch.room);
  const trend = roomIdOf(trendInfo && trendInfo.room);
  return !detected || !record || detected !== record || (trend && detected !== trend);
}

function getWatchState(accountId) {
  try {
    const collector = require('../lib/liveCollector');
    const watch = collector.getLatestWatch().find(a => a.accountId === accountId) || null;
    const trendInfo = collector.getLatestTrend(accountId);
    return { watch, trendInfo };
  } catch (e) {
    return { watch: null, trendInfo: { trend: [], room: null, fetchedAt: null }, error: e.message };
  }
}


function getMarginalSliceFromDB(accountId, minutes = 15) {
  try {
    validateAccount(accountId);
    const cfg = getCockpitConfig(accountId);
    const { watch, trendInfo } = getWatchState(accountId);
    const isLive = !!(watch && watch.isLive);
    if (hasRoomConflict(watch, trendInfo)) {
      return { ...emptyMarginal(minutes, 'conflicted'), error: 'current_room_mismatch' };
    }
    const opts = {
      isLive,
      nowMs: Date.now(),
      sourceAsOf: trendInfo && trendInfo.fetchedAt || watch && watch.fetchedAt || null,
      maxAgeSec: cfg.marginal_stale_seconds,
      flowLow: cfg.flow_low,
      flowHigh: cfg.flow_high,
    };
    const slice = buildMarginalSliceFromTrend(trendInfo && trendInfo.trend, minutes, opts);
    return attachFlowSplit(slice, trendInfo && trendInfo.flowSamples, minutes, opts);
  } catch (e) {
    return { ...emptyMarginal(minutes, 'unavailable'), error: e.message };
  }
}

function getRoiCooldown(accountId, lockMinutes, primaryAdId = null) {
  try {
    const opLog = require('../lib/operationLog');
    const last = primaryAdId
      ? opLog.getLastSuccessfulRoiUpdate(accountId, primaryAdId)
      : opLog.query({ accountId, limit: 500 }).find(l =>
        l.success && (l.action === 'update_roi' || l.action === 'update_budget_roi'));
    if (!last) return { ready: true, last_update_at: null, unlock_at: null, lock_minutes: lockMinutes };
    const ts = parseTimeMs(last.ts);
    if (!Number.isFinite(ts)) return { ready: false, last_update_at: last.ts, unlock_at: null, lock_minutes: lockMinutes, error: 'invalid_oplog_time' };
    const unlock = ts + lockMinutes * 60000;
    return {
      ready: Date.now() >= unlock,
      last_update_at: last.ts,
      unlock_at: new Date(unlock).toISOString(),
      lock_minutes: lockMinutes,
    };
  } catch (e) {
    return { ready: false, last_update_at: null, unlock_at: null, lock_minutes: lockMinutes, error: e.message };
  }
}

function getPlanSnapshot(accountId) {
  try {
    const dashboard = require('./liveDashboard');
    const plan = dashboard.peekPlanCache && dashboard.peekPlanCache(accountId);
    if (!plan) return null;
    return {
      primary_ad_id: plan.primary_ad_id != null ? String(plan.primary_ad_id) : null,
      roi_goal: Number.isFinite(+plan.roi_goal) && +plan.roi_goal > 0 ? +plan.roi_goal : null,
      budget: Number.isFinite(+plan.budget) ? +plan.budget : null,
      source: 'live_dashboard_cache',
    };
  } catch {
    return null;
  }
}

function readAudienceSnapshot(accountId, watch) {
  let demographic = {
    silver_50_plus_rate: null,
    male_rate: null,
    shanghai_rate: null,
    scope: null,
    source: null,
    as_of: null,
    freshness_seconds: null,
    confidence: 0,
    data_quality: 'unavailable',
  };
  try {
    const prefix = `${accountId}_crowd_`;
    const files = fs.readdirSync(COMPASS_CACHE_DIR)
      .filter(f => f.startsWith(prefix) && /^.+_\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort().reverse();
    if (files.length) {
      const j = JSON.parse(fs.readFileSync(path.join(COMPASS_CACHE_DIR, files[0]), 'utf8'));
      const profile = j.profile || {};
      const pick = (arr, name) => {
        const x = (arr || []).find(i => i && i.name === name);
        return x && Number.isFinite(+x.value) ? +x.value * 100 : null;
      };
      const asOf = j.collected_at || null;
      const ageSec = asOf && Number.isFinite(parseTimeMs(asOf)) ? Math.max(0, Math.round((Date.now() - parseTimeMs(asOf)) / 1000)) : null;
      const stale = ageSec == null || ageSec > 48 * 3600;
      demographic = {
        silver_50_plus_rate: round(pick(profile.age, '50岁以上'), 1),
        male_rate: round(pick(profile.sex, '男性'), 1),
        shanghai_rate: round(pick(profile.province_top10, '上海'), 1),
        scope: profile.scope || null,
        source: 'compass_daily_cache',
        as_of: asOf,
        freshness_seconds: ageSec,
        confidence: stale ? 0.5 : 0.9,
        data_quality: stale ? 'stale' : 'complete',
      };
    }
  } catch {  }

  const liveFreshSec = watch && watch.fetchedAt && Number.isFinite(parseTimeMs(watch.fetchedAt))
    ? Math.max(0, Math.round((Date.now() - parseTimeMs(watch.fetchedAt)) / 1000))
    : null;
  const conversionLive = !!(watch && watch.isLive && liveFreshSec != null && liveFreshSec <= 120);
  return {
    ...demographic,
    watch_to_pay: conversionLive && Number.isFinite(+watch.live_metrics?.watchToPayRate)
      ? +watch.live_metrics.watchToPayRate : null,
    click_to_pay: conversionLive && Number.isFinite(+watch.funnel?.clickToPayRate)
      ? +watch.funnel.clickToPayRate : null,
    conversion_source: conversionLive ? 'live_board' : null,
    conversion_as_of: conversionLive ? watch.fetchedAt : null,
    conversion_data_quality: conversionLive ? 'complete' : (watch && watch.isLive ? 'stale' : 'offline'),
  };
}

function getBaselineRows(db, accountId, date, latestSnapshot, minutes, minimumBatchRows = 0) {
  const latestMs = parseTimeMs(latestSnapshot);
  if (!Number.isFinite(latestMs)) return { snapshot: null, map: new Map() };
  const cutoff = new Date(latestMs - minutes * 60000).toISOString();
  const row = db.prepare(`
    SELECT snapshot_time AS snapshot
    FROM material_intraday
    WHERE account_id = ? AND stat_date = ? AND snapshot_time <= ?
    GROUP BY snapshot_time
    HAVING COUNT(*) >= ?
    ORDER BY snapshot_time DESC
    LIMIT 1
  `).get(accountId, date, cutoff, minimumBatchRows);
  if (!row || !row.snapshot) return { snapshot: null, map: new Map() };
  const rows = db.prepare(`
    SELECT material_id, cost, net_gmv_1h, orders, net_data_valid, snapshot_time
    FROM material_intraday
    WHERE account_id = ? AND stat_date = ? AND snapshot_time = ?
  `).all(accountId, date, row.snapshot);
  return { snapshot: row.snapshot, map: new Map(rows.map(r => [String(r.material_id), r])) };
}

function buildMaterialWindow(latest, baseline, minutes) {
  if (!latest || !baseline) return null;
  const latestMs = parseTimeMs(latest.snapshot_time);
  const baselineMs = parseTimeMs(baseline.snapshot_time);
  if (!Number.isFinite(latestMs) || !Number.isFinite(baselineMs) || latestMs <= baselineMs) return null;
  if (!latest.net_data_valid || !baseline.net_data_valid) return null;
  const actualMinutes = (latestMs - baselineMs) / 60000;
  
  if (actualMinutes < minutes * 0.5 || actualMinutes > minutes * 2) return null;
  const deltaSpend = (+latest.cost || 0) - (+baseline.cost || 0);
  const deltaNet = (+latest.net_gmv_1h || 0) - (+baseline.net_gmv_1h || 0);
  const deltaOrders = (+latest.orders || 0) - (+baseline.orders || 0);
  if (deltaSpend < -0.01) {
    return {
      window_minutes: minutes,
      actual_window_minutes: round(actualMinutes, 1),
      data_quality: 'conflicted',
      stale: false,
      net_data_valid: true,
    };
  }
  let quality = actualMinutes >= minutes * 0.7 && actualMinutes <= minutes * 1.6 ? 'complete' : 'partial';
  
  
  if (deltaNet < 0 || deltaOrders < 0) quality = 'backfilled';
  return {
    window_minutes: minutes,
    actual_window_minutes: round(actualMinutes, 1),
    delta_spend: round(Math.max(0, deltaSpend)),
    delta_net_gmv: round(deltaNet),
    delta_orders: Math.round(deltaOrders),
    spend_rate_hour: actualMinutes > 0 ? round(Math.max(0, deltaSpend) * 60 / actualMinutes) : null,
    marginal_net_roi: deltaSpend > 0 ? round(deltaNet / deltaSpend) : null,
    data_quality: quality,
    stale: false,
    net_data_valid: true,
    source: 'material_intraday_diff',
  };
}

function getMaterialEvidence(accountId, date, limit, cfg, opts = {}) {
  const db = getDB();
  
  
  const meta = db.prepare(`
    WITH batches AS (
      SELECT snapshot_time, COUNT(*) AS row_count
      FROM material_intraday
      WHERE account_id = ? AND stat_date = ?
      GROUP BY snapshot_time
    )
    SELECT snapshot_time AS snapshot, row_count
    FROM batches
    WHERE row_count >= (SELECT MAX(row_count) * 0.8 FROM batches)
    ORDER BY snapshot_time DESC
    LIMIT 1
  `).get(accountId, date);
  if (!meta || !meta.snapshot) {
    return {
      materials: [], as_of: null, freshness_seconds: null, data_quality: 'unavailable',
      algorithm: materialEvidenceMeta({ total_material_count: 0, selected_material_count: 0, valid_material_count: 0, valid_coverage_ratio: null, response_coverage_ratio: null, coverage_ratio: null }),
    };
  }
  const latestMs = parseTimeMs(meta.snapshot);
  const freshnessSec = Number.isFinite(latestMs) ? Math.max(0, Math.round((Date.now() - latestMs) / 1000)) : null;
  if (opts.isLive !== true || freshnessSec == null || freshnessSec > cfg.material_stale_seconds) {
    return {
      materials: [],
      as_of: meta.snapshot,
      freshness_seconds: freshnessSec,
      data_quality: opts.isLive === true ? 'stale' : 'offline',
      snapshot_row_count: +meta.row_count || 0,
      algorithm: materialEvidenceMeta({
        total_material_count: +meta.row_count || 0,
        selected_material_count: 0,
        valid_material_count: 0,
        valid_coverage_ratio: 0,
        response_coverage_ratio: 0,
        coverage_ratio: 0,
      }),
    };
  }

  const rows = db.prepare(`
    SELECT material_id, material_name, status, cost, net_gmv_1h, net_roi_1h, orders,
           boost_cost, boost_settle_roi, shows, clicks, cpc, click_rate, convert_rate,
           net_data_valid, snapshot_time
    FROM material_intraday
    WHERE account_id = ? AND stat_date = ? AND snapshot_time = ? AND cost > 0
    ORDER BY cost DESC
  `).all(accountId, date, meta.snapshot)
    .filter(r => ['', '1', '投放中', 'active', 'learning'].includes(String(r.status == null ? '' : r.status)));

  
  const stableEnd = shiftDate(getLocalDateStr(), -1);
  let stableFunnel = { benchmark: {}, materials: new Map() };
  try {
    stableFunnel = loadStableFunnelContext(db, accountId, stableEnd, 7, cfg.material_funnel || {});
  } catch (e) {
    
    stableFunnel = { benchmark: {}, materials: new Map(), error: e.message };
  }
  const liveAcquisitionBenchmark = aggregateFunnelRows(rows.map(r => ({
    cost: r.cost, shows: r.shows, clicks: r.clicks, cpc: r.cpc,
  })));
  const totalNetGmv = rows.reduce((sum, r) => sum + (r.net_data_valid ? (+r.net_gmv_1h || 0) : 0), 0);

  const baselines = {};
  const minimumBatchRows = Math.ceil((+meta.row_count || 0) * 0.8);
  for (const minutes of [5, 15, 30, 60]) {
    baselines[minutes] = getBaselineRows(db, accountId, date, meta.snapshot, minutes, minimumBatchRows);
  }

  const materials = rows.slice(0, limit).map((m, index) => {
    const windows = {};
    for (const minutes of [5, 15, 30, 60]) {
      const w = buildMaterialWindow(m, baselines[minutes].map.get(String(m.material_id)), minutes);
      windows[`m${minutes}`] = w;
    }
    const stable = stableFunnel.materials.get(String(m.material_id));
    const stableMetrics = stable && stable.metrics ? stable.metrics : {};
    const liveClicks = +m.clicks || 0;
    const liveCpc = liveClicks > 0 ? (+m.cost || 0) / liveClicks : (+m.cpc || null);
    const liveCtr = (+m.shows || 0) > 0 && liveClicks > 0 ? liveClicks / +m.shows * 100 : null;
    const funnelMetrics = {
      ...stableMetrics,
      cost: +m.cost || 0,
      shows: +m.shows || stableMetrics.shows || 0,
      clicks: liveClicks || stableMetrics.clicks || 0,
      cpc: liveCpc != null ? round(liveCpc) : stableMetrics.cpc,
      ctr: liveCtr != null ? round(liveCtr) : stableMetrics.ctr,
    };
    const funnelBenchmark = {
      ...(stableFunnel.benchmark || {}),
      cpc: liveAcquisitionBenchmark.cpc || (stableFunnel.benchmark && stableFunnel.benchmark.cpc),
      ctr: liveAcquisitionBenchmark.ctr || (stableFunnel.benchmark && stableFunnel.benchmark.ctr),
    };
    const funnel = evaluateFunnel(funnelMetrics, funnelBenchmark, (stable && stable.insight) || {}, cfg.material_funnel || {});
    funnel.stable_window = stable && stable.stable_window || null;
    funnel.insight_window = stable && stable.insight_window || null;
    const netGmv = m.net_data_valid ? finiteMetric(m.net_gmv_1h) : null;
    const gmvShare = netGmv != null && totalNetGmv > 0 ? netGmv / totalNetGmv : null;
    return {
      material_id: String(m.material_id),
      material_name: m.material_name || String(m.material_id),
      rank: index + 1,
      spend: round(m.cost),
      orders: m.net_data_valid ? finiteMetric(m.orders) : null,
      net_roi: finiteMetric(m.net_roi_1h),
      ...(finiteMetric(m.net_roi_1h) == null ? { net_roi_missing_reason: 'platform_roi_not_stored_in_intraday' } : {}),
      net_gmv: round(netGmv),
      gmv_share: round(gmvShare, 4),
      cpc: liveCpc != null ? round(liveCpc) : null,
      ctr: liveCtr != null ? round(liveCtr) : null,
      funnel,
      data_quality: m.net_data_valid && netGmv != null
        ? (finiteMetric(m.net_roi_1h) != null ? 'complete' : 'partial') : 'unavailable',
      source_at: m.snapshot_time,
      data_scope: 'current_day',
      roi_basis: 'platform_net_1h',
      settlement_window: '1h',
      samples: { shows: finiteMetric(m.shows), clicks: finiteMetric(m.clicks), orders: m.net_data_valid ? finiteMetric(m.orders) : null },
      boost_spend: finiteMetric(m.boost_cost),
      marginal: windows,
    };
  });

  const netRows = rows.filter(r => r.net_data_valid && finiteMetric(r.net_gmv_1h) != null);
  const validRows = netRows.filter(r => finiteMetric(r.net_roi_1h) != null).length;
  const selectedCount = materials.length;
  return {
    materials,
    as_of: meta.snapshot,
    freshness_seconds: freshnessSec,
    data_quality: validRows === rows.length ? 'complete' : (netRows.length > 0 ? 'partial' : 'unavailable'),
    source: 'material_intraday',
    active_material_count: rows.length,
    snapshot_row_count: +meta.row_count || 0,
    algorithm: materialEvidenceMeta({
      total_material_count: rows.length,
      selected_material_count: selectedCount,
      valid_material_count: validRows,
      valid_coverage_ratio: rows.length ? +Math.min(1, validRows / rows.length).toFixed(3) : null,
      response_coverage_ratio: rows.length ? +Math.min(1, selectedCount / rows.length).toFixed(3) : null,
      coverage_ratio: rows.length ? +Math.min(1, selectedCount / rows.length).toFixed(3) : null,
    }),
  };
}


function buildFlowSplitFromSamples(samples, minutes, opts = {}) {
  const nowMs = Number.isFinite(+opts.nowMs) ? +opts.nowMs : Date.now();
  const maxAgeSec = Number.isFinite(+opts.maxAgeSec) ? +opts.maxAgeSec : 120;
  const rows = (Array.isArray(samples) ? samples : []).map(sample => ({
    ts: Number.isFinite(+sample.ts) ? +sample.ts : parseTimeMs(sample.at),
    at: sample.at || null,
    total: Number(sample.totalCost),
    basic: Number(sample.basicCost),
    assist: Number(sample.assistCost),
  })).filter(sample => Number.isFinite(sample.ts) && Number.isFinite(sample.total) &&
    Number.isFinite(sample.basic) && Number.isFinite(sample.assist))
    .sort((a, b) => a.ts - b.ts);
  if (rows.length < 2) return { data_quality: 'collecting', actual_window_minutes: 0 };

  const latest = rows[rows.length - 1];
  const freshnessSec = Math.max(0, Math.round((nowMs - latest.ts) / 1000));
  if (freshnessSec > maxAgeSec) return { data_quality: 'stale', actual_window_minutes: 0, freshness_seconds: freshnessSec };
  const targetTs = latest.ts - minutes * 60000;
  const candidates = rows.slice(0, -1);
  const baseline = candidates.reduce((best, sample) => (
    !best || Math.abs(sample.ts - targetTs) < Math.abs(best.ts - targetTs) ? sample : best
  ), null);
  const actualMinutes = baseline ? (latest.ts - baseline.ts) / 60000 : 0;
  if (!(actualMinutes > 0)) return { data_quality: 'collecting', actual_window_minutes: 0 };

  const deltaTotal = latest.total - baseline.total;
  const deltaBasic = latest.basic - baseline.basic;
  const deltaAssist = latest.assist - baseline.assist;
  if (deltaTotal < -0.01 || deltaBasic < -0.01 || deltaAssist < -0.01 ||
    Math.abs(deltaTotal - deltaBasic - deltaAssist) > 0.5) {
    return { data_quality: 'reset', actual_window_minutes: round(actualMinutes, 1) };
  }
  const quality = actualMinutes >= minutes * 0.7 && actualMinutes <= minutes * 1.3
    ? 'complete'
    : 'partial';
  return {
    data_quality: quality,
    actual_window_minutes: round(actualMinutes, 1),
    delta_total_spend: round(Math.max(0, deltaTotal)),
    delta_basic_spend: round(Math.max(0, deltaBasic)),
    delta_assist_spend: round(Math.max(0, deltaAssist)),
    assist_share_pct: deltaTotal > 0 ? round(Math.max(0, deltaAssist) / deltaTotal * 100, 1) : 0,
    freshness_seconds: freshnessSec,
    source: 'live_collector.cumulative_cost_samples',
  };
}

function attachFlowSplit(slice, samples, minutes, opts = {}) {
  const base = {
    ...slice,
    total_spend_rate_hour: slice && slice.spend_rate_hour != null ? slice.spend_rate_hour : null,
  };
  const split = buildFlowSplitFromSamples(samples, minutes, opts);
  const totalRate = Number(base.total_spend_rate_hour);
  const deltaSpend = Number(base.delta_spend);
  const share = Number(split.assist_share_pct);
  
  
  const usable = split.data_quality === 'complete' && base.data_quality === 'complete' &&
    Number.isFinite(totalRate) && Number.isFinite(deltaSpend) && Number.isFinite(share);
  if (!usable) {
    return {
      ...base,
      basic_spend_rate_hour: null,
      assist_spend_rate_hour: null,
      delta_basic_spend: null,
      delta_assist_spend: null,
      assist_share_pct: null,
      flow_split_quality: split.data_quality,
      flow_split_actual_minutes: split.actual_window_minutes || 0,
      flow_split_source: split.source || null,
    };
  }
  const assistRatio = Math.min(1, Math.max(0, share / 100));
  const assistRate = totalRate * assistRatio;
  const assistDelta = deltaSpend * assistRatio;
  return {
    ...base,
    basic_spend_rate_hour: round(totalRate - assistRate),
    assist_spend_rate_hour: round(assistRate),
    delta_basic_spend: round(deltaSpend - assistDelta),
    delta_assist_spend: round(assistDelta),
    assist_share_pct: round(assistRatio * 100, 1),
    flow_split_quality: split.data_quality,
    flow_split_actual_minutes: split.actual_window_minutes,
    flow_split_source: split.source,
    flow_split_method: 'cumulative_assist_share_applied_to_total_trend',
  };
}



function buildGlobalActions() { return []; }

function slimMaterial(m) {
  return {
    id: m.material_id,
    name: m.material_name,
    rank: m.rank,
    spend: m.spend,
    orders: m.orders,
    net_roi: m.net_roi,
    net_roi_missing_reason: m.net_roi_missing_reason,
    net_gmv: m.net_gmv,
    gmv_share: m.gmv_share,
    cpc: m.cpc,
    ctr: m.ctr,
    quality: m.data_quality,
    source_at: m.source_at,
    data_scope: m.data_scope,
    roi_basis: m.roi_basis,
    settlement_window: m.settlement_window,
    samples: m.samples,
    boost_spend: m.boost_spend,
    marginal: m.marginal,
    funnel: m.funnel ? {
      diagnosis: m.funnel.diagnosis,
      failure_hits: m.funnel.failure_hits,
      drop_amplifier: m.funnel.drop_amplifier,
      signals: m.funnel.signals,
      rate3s: m.funnel.metrics && m.funnel.metrics.rate3s,
      finish_rate: m.funnel.metrics && m.funnel.metrics.finish_rate,
      avg_watch_time: m.funnel.metrics && m.funnel.metrics.avg_watch_time,
      cpc: m.funnel.metrics && m.funnel.metrics.cpc,
      cpc_rel: m.funnel.metrics && m.funnel.metrics.cpc_rel,
      drop_count_30d: m.funnel.metrics && m.funnel.metrics.drop_count_30d,
      stable_window: m.funnel.stable_window || null,
    } : null,
  };
}


async function handleLiveCockpit(req, res, urlOrQuery = {}) {
  try {
    const requestedAccount = queryValue(urlOrQuery, 'account', queryValue(urlOrQuery, 'accountId', null));
    const account = validateAccount(requestedAccount);
    const limit = Math.min(Math.max(parseInt(queryValue(urlOrQuery, 'limit', '10'), 10) || 10, 1), 30);
    const slot = String(queryValue(urlOrQuery, 'slot', 'normal'));
    const slim = parseBool(queryValue(urlOrQuery, 'slim', '1'), true);
    const cacheKey = `${account}_${limit}_${slot}_${slim ? 1 : 0}`;
    const hit = _cockpitCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return sendJSON(res, hit.data, 200);

    const cfg = getCockpitConfig(account);
    const { watch, trendInfo, error: collectorError } = getWatchState(account);
    
    const evaluationNowMs = Date.now();
    const evaluationNowIso = new Date(evaluationNowMs).toISOString();
    const isLive = !!(watch && watch.isLive);
    const collecting = !!(watch && watch.collecting);
    const collectorAsOf = watch && watch.fetchedAt || null;
    const collectorFreshnessSec = collectorAsOf && Number.isFinite(parseTimeMs(collectorAsOf))
      ? Math.max(0, Math.round((evaluationNowMs - parseTimeMs(collectorAsOf)) / 1000))
      : null;
    const collectorStale = isLive && (collectorFreshnessSec == null || collectorFreshnessSec > cfg.collector_stale_seconds);

    const lm = watch && watch.live_metrics || {};
    const liveMetricState = normalizeLiveMetricState(lm, { isLive, collecting });
    const { strictNetAvailable, spend, netGmv } = liveMetricState;
    const netRoi = liveMetricState.netRoi;
    const sessionStartAt = watch && watch.room && (watch.room.start_time || watch.room.startTime) || null;
    const sessionStartMs = parseTimeMs(sessionStartAt);
    const sessionElapsedMinutes = isLive && Number.isFinite(sessionStartMs)
      ? Math.max(0, (evaluationNowMs - sessionStartMs) / 60000)
      : null;
    const sessionAverageFlow = strictNetAvailable && sessionElapsedMinutes > 0
      ? spend * 60 / sessionElapsedMinutes
      : null;
    const summary = {
      spend: round(spend),
      net_gmv: round(netGmv),
      orders: liveMetricState.orders,
      net_roi: round(netRoi),
      pay_roi: round(liveMetricState.payRoi),
      online: liveMetricState.online,
      gpm: round(liveMetricState.gpm),
      session_average_flow: round(sessionAverageFlow),
      session_elapsed_minutes: round(sessionElapsedMinutes, 1),
      source: strictNetAvailable ? 'live_board' : null,
      as_of: strictNetAvailable ? collectorAsOf : null,
      freshness_seconds: collectorFreshnessSec,
      data_quality: !isLive ? 'offline' : (collecting ? 'collecting' : (collectorStale ? 'stale' : (strictNetAvailable ? 'complete' : 'unavailable'))),
    };

    const roomId = roomIdOf(watch && watch.room);
    const detectedRoomId = watch && watch.detectedRoomId != null ? String(watch.detectedRoomId) : '';
    const roomConflict = hasRoomConflict(watch, trendInfo);
    if (roomConflict) {
      Object.assign(summary, {
        spend: null, net_gmv: null, orders: null, net_roi: null,
        source: null, as_of: null, data_quality: 'conflicted',
      });
    }
    const marginal = {};
    for (const minutes of [5, 15, 30, 60]) {
      const opts = {
        isLive,
        nowMs: evaluationNowMs,
        sourceAsOf: trendInfo && trendInfo.fetchedAt || collectorAsOf,
        maxAgeSec: cfg.marginal_stale_seconds,
        flowLow: cfg.flow_low,
        flowHigh: cfg.flow_high,
      };
      const slice = roomConflict
        ? { ...emptyMarginal(minutes, 'conflicted'), error: 'current_room_mismatch' }
        : attachFlowSplit(
          buildMarginalSliceFromTrend(trendInfo && trendInfo.trend, minutes, opts),
          trendInfo && trendInfo.flowSamples,
          minutes,
          opts,
        );
      marginal[`m${minutes}`] = withFlowRole(slice, minutes);
    }
    const liveDynamicsShadow = getLiveDynamicsShadow({
      accountId: account,
      isLive,
      roomConflict,
      collectorStale,
      strictNetAvailable,
      trendInfo,
      cfg,
    });
    let accountProfile = null;
    try {
      accountProfile = loadAccountProfile(account);
    } catch {
      
      accountProfile = null;
    }
    const expansionDilutionShadow = evaluateExpansionDilutionShadow({
      isLive,
      roomConflict,
      collectorStale,
      strictNetAvailable,
      sessionKey: watch && watch.session_key || null,
      trendInfo,
      marginal,
      thresholds: cfg,
      profile: accountProfile,
      funnel: watch && watch.funnel || null,
      trendMaxAgeSec: cfg.marginal_stale_seconds,
      nowMs: evaluationNowMs,
      sourceAsOf: trendInfo && trendInfo.fetchedAt || collectorAsOf,
    });
    const shadowEvidence = persistExpansionDilutionEvidence(account, {
      sessionKey: watch && watch.session_key || null,
      evaluatedAt: evaluationNowIso,
      sourceAt: trendInfo && trendInfo.fetchedAt || collectorAsOf,
      isLive,
      roomConflict,
      collectorStale,
      strictNetAvailable,
      trendInfo,
      marginal,
      funnel: watch && watch.funnel || null,
      profile: accountProfile,
      shadow: expansionDilutionShadow,
    });
    const shadowEvidenceFailed = shadowEvidence.failed;
    const shadowEvidenceRef = shadowEvidence.ref;
    const expansionDilutionWithEvidence = {
      ...expansionDilutionShadow,
      evidence_ref: shadowEvidenceRef,
    };

    const plan = getPlanSnapshot(account);
    const planControlUsable = !!(
      plan && plan.primary_ad_id != null && Number.isFinite(+plan.roi_goal) && +plan.roi_goal > 0
    );
    const materialHealth = getMaterialEvidence(account, getLocalDateStr(), limit, cfg, {
      isLive,
      slot,
      roiGoal: plan && plan.roi_goal,
    });
    const audience = readAudienceSnapshot(account, watch);
    const cooldown = getRoiCooldown(account, cfg.roi_lock_minutes, plan && plan.primary_ad_id);
    const actions = buildGlobalActions({
      isLive,
      collecting,
      collectorStale,
      summary,
      marginal,
      thresholds: cfg,
      plan,
      cooldown,
      materials: materialHealth.materials,
    });

    const payload = {
      ok: true,
      schema_version: '2.2-evidence',
      mode: getAccountMode(account),
      as_of: evaluationNowIso,
      account,
      room_id: roomId || null,
      detected_room_id: detectedRoomId || null,
      isLive,
      collecting,
      data_degraded: isPrimaryCockpitDataDegraded({
        collectorError,
        liveStateError: watch && watch.liveStateError,
        collectorStale,
        roomConflict,
        isLive,
        strictNetAvailable,
        planControlUsable,
        marginalM15Quality: marginal.m15.data_quality,
      }),
      summary: { ...summary, benchmark_flow: cfg.flow_benchmark },
      flow_contract: FLOW_CONTRACT,
      marginal,
      live_dynamics_shadow: liveDynamicsShadow,
      expansion_dilution_shadow: expansionDilutionWithEvidence,
      audience,
      plan: {
        ...(plan || { primary_ad_id: null, roi_goal: null, budget: null, source: null }),
        control_data_quality: planControlUsable ? 'complete' : 'unavailable',
        control_block_reason: planControlUsable ? null : 'plan_identity_or_roi_goal_missing',
        cooldown,
      },
      materials: slim ? materialHealth.materials.map(slimMaterial) : materialHealth.materials,
      material_meta: {
        as_of: materialHealth.as_of,
        freshness_seconds: materialHealth.freshness_seconds,
        data_quality: materialHealth.data_quality,
        source: materialHealth.source || null,
        active_material_count: materialHealth.active_material_count || 0,
        snapshot_row_count: materialHealth.snapshot_row_count || 0,
        algorithm: materialHealth.algorithm || materialEvidenceMeta({
          total_material_count: 0,
          selected_material_count: 0,
          valid_material_count: 0,
          valid_coverage_ratio: null,
          response_coverage_ratio: null,
          coverage_ratio: null,
        }),
      },
      thresholds: {
        break_even_roi: cfg.break_even_roi,
        profit_roi: cfg.profit_roi,
        floor_roi: cfg.floor_roi,
        flow_low: cfg.flow_low,
        flow_high: cfg.flow_high,
        flow_window_minutes: FLOW_CONTRACT.canonical_window_minutes,
        flow_field: FLOW_CONTRACT.canonical_field,
        source: cfg.source,
        calibrated: cfg.calibrated,
      },
      actions,
    };

    
    if (!shadowEvidenceFailed) _cockpitCache.set(cacheKey, { ts: Date.now(), data: payload });
    return sendJSON(res, payload, 200);
  } catch (err) {
    return handleApiError(res, err, 'live_cockpit');
  }
}

module.exports = {
  handleLiveCockpit,
  getMarginalSliceFromDB,
  buildMarginalSliceFromTrend,
  buildFlowSplitFromSamples,
  attachFlowSplit,
  buildMaterialWindow,
  getMaterialEvidence,
  slimMaterial,
  buildGlobalActions,
  persistExpansionDilutionEvidence,
  isPrimaryCockpitDataDegraded,
  normalizeLiveMetricState,
  getCockpitConfig,
  readAudienceSnapshot,
  hasRoomConflict,
};
