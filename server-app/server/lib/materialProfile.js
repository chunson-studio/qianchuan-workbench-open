
const fs = require('fs');
const path = require('path');
const { getDB } = require('./db');
const { computeLifecycle } = require('./lifecycle');
const { CACHE_DIR } = require('./config');
const { daysAgo, yesterday } = require('./utils');

const PROFILE_CACHE_DIR = path.join(CACHE_DIR, 'material_profile');

const GMV_METRIC = 'total_pay_order_gmv_include_coupon_for_roi2';
const WATCH_METRIC = 'live_watch_count_for_roi2_v2';

const MIN_COST_FOR_INSIGHT = null;

const MAX_MATERIALS_PER_SET = null;

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function pct(share) { return Math.round((share || 0) * 100) + '%'; }


function parseCreativeTags(creativeJson, scriptJson) {
  let creative = null;
  let script = null;
  try { creative = creativeJson ? JSON.parse(creativeJson) : null; } catch {  }
  try { script = scriptJson ? JSON.parse(scriptJson) : null; } catch {  }
  const tags = [];
  const add = value => {
    const text = typeof value === 'string'
      ? value
      : value && (value.text || value.name || value.label || value.tag_name);
    if (text && !tags.includes(String(text))) tags.push(String(text));
  };
  for (const group of (creative && creative.myTags) || []) {
    for (const tag of group.tags || []) add(tag);
  }
  for (const group of (creative && creative.creative_tags) || []) {
    for (const tag of group.tag_name_list || group.tags || []) add(tag);
  }
  for (const tag of (creative && creative.tags) || []) add(tag);
  for (const group of (script && script.formula) || []) {
    for (const tag of group.tags || []) add(tag);
  }
  return tags.slice(0, 8);
}





function readDayCache(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeDayCache(file, data) {
  try {
    if (!fs.existsSync(PROFILE_CACHE_DIR)) fs.mkdirSync(PROFILE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {  }
}

function invalidateMaterialProfileCache(accountId, materialId) {
  if (!fs.existsSync(PROFILE_CACHE_DIR)) return 0;
  const safeAccount = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeMaterial = String(materialId).replace(/[^a-zA-Z0-9:_-]/g, '_');
  const prefixes = [
    `profile_${safeAccount}_${safeMaterial}_`,
    `profile_v2_${safeAccount}_${safeMaterial}_`,
  ];
  let removed = 0;
  for (const file of fs.readdirSync(PROFILE_CACHE_DIR)) {
    if (!prefixes.some(prefix => file.startsWith(prefix))) continue;
    try {
      fs.unlinkSync(path.join(PROFILE_CACHE_DIR, file));
      removed++;
    } catch {  }
  }
  return removed;
}






function parseCrowd(crowdJson) {
  let crowd;
  try { crowd = JSON.parse(crowdJson); } catch { return null; }
  if (!crowd || typeof crowd !== 'object') return null;
  const dist = (dim) => {
    const d = crowd[dim];
    if (!d) return {};
    let rows = Array.isArray(d[GMV_METRIC]) ? d[GMV_METRIC] : [];
    if (!rows.length || rows.every(r => !r.value)) {
      rows = Array.isArray(d[WATCH_METRIC]) ? d[WATCH_METRIC] : [];
    }
    const total = rows.reduce((s, r) => s + (r.value || 0), 0);
    if (total <= 0) return {};
    const m = {};
    for (const r of rows) {
      if (r && r.label) m[r.label] = (r.value || 0) / total;
    }
    return m;
  };
  const topN = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
  const genderDist = dist('gender');
  const ageDist = dist('age');
  const regionDist = dist('province_name');
  if (!Object.keys(genderDist).length && !Object.keys(ageDist).length) return null;
  return {
    genderDist,
    ageDist,
    regionDist,
    genderTop: topN(genderDist, 1)[0] || null,
    ageTop: topN(ageDist, 2),
    regionTop: topN(regionDist, 5),
  };
}


function parseCrowdArrays(crowdJson) {
  let crowd;
  try { crowd = JSON.parse(crowdJson); } catch { return null; }
  if (!crowd || typeof crowd !== 'object') return null;
  const dims = {
    gender: '性别',
    age: '年龄',
    province_name: '省份',
    city_name: '城市',
    user_group_label_name: '八大人群'
  };
  const out = {};
  for (const [dim, label] of Object.entries(dims)) {
    const d = crowd[dim];
    if (!d) continue;
    let rows = Array.isArray(d[GMV_METRIC]) ? d[GMV_METRIC] : [];
    if (!rows.length || rows.every(r => !r.value)) {
      rows = Array.isArray(d[WATCH_METRIC]) ? d[WATCH_METRIC] : [];
    }
    const total = rows.reduce((s, r) => s + (r.value || 0), 0);
    if (total <= 0) continue;
    out[dim] = rows.map(r => ({
      label: r.label || '',
      count: r.value || 0,
      rate: (r.value || 0) / total
    })).sort((a, b) => b.count - a.count);
  }
  return Object.keys(out).length ? out : null;
}


function intersectCrowd(profiles) {
  if (!profiles.length) return { count: 0, gender: null, gender_share: 0, age: [], region: [] };
  
  const genderVotes = {};
  for (const p of profiles) {
    if (p.genderTop) genderVotes[p.genderTop] = (genderVotes[p.genderTop] || 0) + 1;
  }
  const gender = (Object.entries(genderVotes).sort((a, b) => b[1] - a[1])[0] || [])[0] || null;
  let genderShare = 0;
  if (gender) {
    genderShare = round2(profiles.reduce((s, p) => s + (p.genderDist[gender] || 0), 0) / profiles.length);
  }
  
  const ageCount = {};
  for (const p of profiles) for (const a of p.ageTop) ageCount[a] = (ageCount[a] || 0) + 1;
  const half = Math.ceil(profiles.length / 2);
  let age = Object.entries(ageCount).filter(([, c]) => c >= half)
    .sort((a, b) => b[1] - a[1]).map(e => e[0]);
  if (!age.length) {
    age = Object.entries(ageCount).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  }
  age = age.slice(0, 2);
  
  const regCount = {};
  for (const p of profiles) for (const r of p.regionTop) regCount[r] = (regCount[r] || 0) + 1;
  const third = Math.max(1, Math.ceil(profiles.length / 3));
  const region = Object.entries(regCount).filter(([, c]) => c >= third)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  return { count: profiles.length, gender, gender_share: genderShare, age, region };
}






function resolveLifecycle(rows, createdAt) {
  try {
    
    return computeLifecycle({ '创建时间': createdAt || '' }, rows, rows[0].stat_date, yesterday()).phase.name;
  } catch {
    return '稳定期';
  }
}


function calcTrendCn() { return '未作策略判定'; }


function buildSummary(p) { return `累计消耗${p.cost_total}元，净ROI ${p.roi_total}；不提供策略评级。`; }


function buildMaterialProfile(materialId, accountId) {
  const db = getDB();
  const rows = db.prepare(`
    SELECT * FROM material_daily
    WHERE account_id = ? AND material_id = ?
    ORDER BY stat_date
  `).all(accountId, materialId);
  if (!rows.length) return null;

  const yStr = yesterday();
  const start30 = daysAgo(30);
  const latest = rows[rows.length - 1];
  const name = ([...rows].reverse().find(r => r.material_name) || {}).material_name || '';

  const activeRows = rows.filter(r => r.cost > 0);
  const daysActive = activeRows.length;
  const costTotal = round2(rows.reduce((s, r) => s + (r.cost || 0), 0));
  const netTotal = rows.reduce((s, r) => s + (r.net_gmv || 0), 0);
  const roiTotal = costTotal > 0 ? round2(netTotal / costTotal) : 0;

  const rows30 = rows.filter(r => r.stat_date >= start30 && r.stat_date <= yStr);
  const cost30 = round2(rows30.reduce((s, r) => s + (r.cost || 0), 0));
  const net30 = rows30.reduce((s, r) => s + (r.net_gmv || 0), 0);
  const roi30 = cost30 > 0 ? round2(net30 / cost30) : 0;

  
  const start7 = daysAgo(7);
  const rows7 = rows.filter(r => r.stat_date >= start7 && r.stat_date <= yStr);
  const cost7 = round2(rows7.reduce((s, r) => s + (r.cost || 0), 0));
  const net7 = rows7.reduce((s, r) => s + (r.net_gmv || 0), 0);
  const roi7 = cost7 > 0 ? round2(net7 / cost7) : 0;
  const clicks7 = rows7.reduce((s, r) => s + (+r.clicks || 0), 0);
  const cpc7 = clicks7 > 0 ? round2(cost7 / clicks7) : null;

  
  const byDate = {};
  for (const r of rows) byDate[r.stat_date] = r;
  const makeTrend = n => {
    const arr = [];
    for (let i = n; i >= 1; i--) {
      const d = daysAgo(i);
      const r = byDate[d];
      const cost = r ? round2(r.cost || 0) : 0;
      const net = r ? (r.net_gmv || 0) : 0;
      arr.push({ date: d, cost, roi: cost > 0 ? round2(net / cost) : 0 });
    }
    return arr;
  };
  const trend14 = makeTrend(14);
  const trend30 = makeTrend(30);

  
  const crowdRow = db.prepare(`
    SELECT crowd_json FROM material_crowd
    WHERE account_id = ? AND material_id = ? ORDER BY stat_date DESC LIMIT 1
  `).get(accountId, materialId);
  const crowdProfile = crowdRow ? parseCrowd(crowdRow.crowd_json) : null;
  const crowdArrays = crowdRow ? parseCrowdArrays(crowdRow.crowd_json) : null;
  const audience = crowdProfile
    ? { gender: crowdProfile.genderTop, age: crowdProfile.ageTop[0] || null, region_top: crowdProfile.regionTop.slice(0, 3) }
    : { gender: null, age: null, region_top: [] };

  
  
  const contentRows = db.prepare(`
    SELECT script_json, creative_json FROM material_content
    WHERE account_id = ? AND material_id = ?
      AND (script_json IS NOT NULL OR creative_json IS NOT NULL)
    ORDER BY stat_date DESC
  `).all(accountId, materialId);
  const scriptRow = contentRows.find(row => row.script_json) || null;
  const creativeRow = contentRows.find(row => row.creative_json) || null;
  let script = null;
  if (scriptRow) {
    try { script = JSON.parse(scriptRow.script_json).text || null; } catch {  }
  }
  const creativeTags = parseCreativeTags(
    creativeRow && creativeRow.creative_json,
    scriptRow && scriptRow.script_json
  );

  
  const insightRow = db.prepare(`
    SELECT total_seconds, lose_rate_5s, click_count, drop_count, seconds_json FROM material_insight
    WHERE account_id = ? AND material_id = ? ORDER BY stat_date DESC LIMIT 1
  `).get(accountId, materialId);
  const retention = {
    total_seconds: insightRow ? insightRow.total_seconds : null,
    lose_rate_5s: insightRow ? insightRow.lose_rate_5s : null,
    finish_rate: round2(latest.finish_rate),
    rate3s: round2(latest.rate3s),
    avg_watch_time: round2(latest.avg_watch_time),
    clicks_7d: clicks7,
    cpc_7d: cpc7,
    click_count: insightRow ? (insightRow.click_count || 0) : null,
    drop_count: insightRow ? (insightRow.drop_count || 0) : null,
  };
  
  let retentionCurve = null;
  if (insightRow && insightRow.seconds_json) {
    try {
      retentionCurve = JSON.parse(insightRow.seconds_json)
        .map(r => ({ second: +r.second || 0, viewers: +r.watchCount || 0 }))
        .filter(p => p.second >= 0);
    } catch { retentionCurve = null; }
  }

  const lifecycle = resolveLifecycle(rows, latest.created_at);
  const profile = {
    material_id: materialId,
    name,
    summary: '',
    days_active: daysActive,
    cost_total: costTotal,
    roi_total: roiTotal,
    cost_30d: cost30,
    roi_30d: roi30,
    cost_7d: cost7,
    roi_7d: roi7,
    lifecycle,
    audience,
    audience_dist: crowdProfile, 
    audience_full: crowdArrays,   
    script,
    creative_tags: creativeTags,
    retention,
    retention_curve: retentionCurve, 
    trend_14d: trend14,
    trend_30d: trend30,
    _trendCn: calcTrendCn(trend14),
  };
  profile.summary = buildSummary(profile);
  delete profile._trendCn;
  return profile;
}






function buildAdvice() { return []; }


function buildAudienceInsight() { return {available:false,code:'private_strategy_not_included',advice:[]}; }

module.exports = {
  PROFILE_CACHE_DIR,
  readDayCache,
  writeDayCache,
  invalidateMaterialProfileCache,
  buildMaterialProfile,
  buildAudienceInsight,
};
