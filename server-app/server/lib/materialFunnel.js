


const DEFAULTS = Object.freeze({});

function finite(v) {
  return v != null && v !== '' && Number.isFinite(+v) ? +v : null;
}

function round(v, digits = 2) {
  return Number.isFinite(v) ? +v.toFixed(digits) : null;
}

function parseDurationSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 0 ? value : null;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = +raw;
    return n > 0 ? n : null;
  }
  const parts = raw.split(':').map(Number);
  if (!parts.length || parts.some(v => !Number.isFinite(v) || v < 0)) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds > 0 ? seconds : null;
}


function asPercent(value) {
  const n = finite(value);
  if (n == null || n < 0) return null;
  return n;
}

function aggregateFunnelRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let cost = 0, plays = 0, shows = 0, clicks = 0;
  let rate3sSum = 0, rate3sWeight = 0;
  let finishSum = 0, finishWeight = 0;
  let watchSum = 0, watchWeight = 0;
  let watchRatioSum = 0, watchRatioWeight = 0;
  let estimatedClicks = 0;

  for (const row of list) {
    const rowCost = Math.max(0, finite(row.cost) || 0);
    const rowPlays = Math.max(0, finite(row.plays) || 0);
    const rowShows = Math.max(0, finite(row.shows) || 0);
    const rowClicks = Math.max(0, finite(row.clicks != null ? row.clicks : row.click_count) || 0);
    cost += rowCost;
    plays += rowPlays;
    shows += rowShows;
    clicks += rowClicks;

    const reportedCpc = finite(row.cpc);
    if (rowClicks <= 0 && reportedCpc != null && reportedCpc > 0 && rowCost > 0) {
      estimatedClicks += rowCost / reportedCpc;
    }

    const rate3s = asPercent(row.rate3s);
    if (rate3s != null && rowPlays > 0) {
      rate3sSum += rate3s * rowPlays;
      rate3sWeight += rowPlays;
    }
    const finishRate = asPercent(row.finish_rate != null ? row.finish_rate : row.finishRate);
    if (finishRate != null && rowPlays > 0) {
      finishSum += finishRate * rowPlays;
      finishWeight += rowPlays;
    }
    const avgWatch = finite(row.avg_watch_time != null ? row.avg_watch_time : row.avgWatchTime);
    if (avgWatch != null && avgWatch >= 0 && rowPlays > 0) {
      watchSum += avgWatch * rowPlays;
      watchWeight += rowPlays;
      const duration = parseDurationSeconds(row.duration);
      if (duration) {
        watchRatioSum += Math.min(avgWatch / duration, 1) * rowPlays;
        watchRatioWeight += rowPlays;
      }
    }
  }

  const effectiveClicks = clicks > 0 ? clicks : estimatedClicks;
  return {
    cost: round(cost),
    plays: Math.round(plays),
    shows: Math.round(shows),
    clicks: Math.round(clicks),
    clicks_estimated: clicks <= 0 && estimatedClicks > 0 ? round(estimatedClicks) : null,
    ctr: shows > 0 && effectiveClicks > 0 ? round(effectiveClicks / shows * 100) : null,
    cpc: effectiveClicks > 0 ? round(cost / effectiveClicks) : null,
    cpc_source: clicks > 0 ? 'cost_div_clicks' : (estimatedClicks > 0 ? 'reported_cpc_estimate' : null),
    rate3s: rate3sWeight > 0 ? round(rate3sSum / rate3sWeight) : null,
    finish_rate: finishWeight > 0 ? round(finishSum / finishWeight) : null,
    avg_watch_time: watchWeight > 0 ? round(watchSum / watchWeight) : null,
    watch_ratio: watchRatioWeight > 0 ? round(watchRatioSum / watchRatioWeight, 4) : null,
  };
}

function ratio(value, baseline) {
  return value != null && baseline != null && baseline > 0 ? value / baseline : null;
}

function evaluateFunnel(material) { return {data_quality:'not_evaluated',diagnosis:'STRATEGY_NOT_INCLUDED',failure_hits:null,signals:[],metrics:material || {}}; }

module.exports = {
  DEFAULTS,
  parseDurationSeconds,
  asPercent,
  aggregateFunnelRows,
  evaluateFunnel,
};
