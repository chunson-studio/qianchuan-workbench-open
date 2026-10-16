const { getLocalDateStr } = require('./utils');
/**
 * server/lib/materialAudience.js — 批量素材人群画像
 *
 * 遍历指定区间的真实素材，逐条拉人群画像(8大人群/年龄/性别/城市/省份)，
 * 存盘 + 返回结构化结果(含账号整体人群加总)。
 *
 * 人群画像是 T+1 数据(当天空)，end 自动钳制到昨天。见 REVERSE_API.md §10.8。
 *
 * 两种模式:
 *   mode='fixed'    每条素材用统一 [startDate, endDate] 窗口(旧行为)
 *   mode='lifetime' 每条素材用 [上传日, 昨天] 窗口 —— 反映"这条素材一辈子吃谁"，
 *                   适合素材人群决策(老素材不被近期流量带偏)。推荐。
 */
const fs = require('fs');
const path = require('path');
const { CACHE_DIR } = require('./config');
const { fetchRecommendData, fetchMaterialAudience } = require('./qianchuanTabs');

const AUDIENCE_CACHE_DIR = path.join(CACHE_DIR, 'material_audience');
if (!fs.existsSync(AUDIENCE_CACHE_DIR)) fs.mkdirSync(AUDIENCE_CACHE_DIR, { recursive: true });

function yesterdayStr() {
  const d = new Date(Date.now() - 86400000);
  return getLocalDateStr(d);
}

/**
 * 批量拉人群画像
 * @param {string} startDate YYYY-MM-DD (列表筛选窗口起点；lifetime 模式下也是最早上传日下限)
 * @param {string} endDate   YYYY-MM-DD (列表筛选窗口终点；自动钳制昨天)
 * @param {object} opts { minCost=0, concurrency=8, mode='lifetime', onProgress }
 * @returns {Promise<object>} { start,end,mode,count,results,overallCrowd,overallGender,overallAge,file }
 */
async function batchMaterialAudience(startDate, endDate, opts = {}) {
  const { minCost = 0, concurrency = 3, mode = 'lifetime', onProgress = null, accountId } = opts;

  const yest = yesterdayStr();
  if (endDate > yest) endDate = yest;

  const listRes = await fetchRecommendData(startDate, endDate, accountId);
  const all = listRes.rows || [];
  const real = all.map(row => ({
    id: row.Dimensions?.material_id?.Value,
    name: row.Dimensions?.material_name_v2?.ValueStr || row.Dimensions?.material_name_v2?.Value || '',
    cost: row.Metrics?.stat_cost_for_roi2?.Value || 0,
    createTime: row.Dimensions?.material_create_time_v2?.Value || '', // "2026-05-07 17:34:43"
  })).filter(m => m.id && m.id !== '-2' && m.id !== '-1' && m.cost >= minCost)
    .sort((a, b) => b.cost - a.cost);

  const results = [];
  let idx = 0, done = 0;
  async function worker() {
    while (idx < real.length) {
      const m = real[idx++];
      done++;
      try {
        // lifetime 模式: 每条素材用自己的 [上传日, 昨天] 窗口
        let qStart = startDate, qEnd = endDate;
        if (mode === 'lifetime' && m.createTime) {
          qStart = m.createTime.slice(0, 10); // "2026-05-07"
          qEnd = yest;
        }
        const aud = await fetchMaterialAudience(m.id, qStart, qEnd, accountId);
        const hasData = aud.user_group_label_name && aud.user_group_label_name.length > 0;
        if (!hasData) { if (onProgress) onProgress(done, real.length, m, null); continue; }
        const item = { id: m.id, name: m.name, cost: m.cost, createTime: m.createTime, window: { start: qStart, end: qEnd }, audience: aud };
        results.push(item);
        if (onProgress) onProgress(done, real.length, m, item);
      } catch (e) {
        if (onProgress) onProgress(done, real.length, m, null, e);
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, real.length) }, () => worker());
  await Promise.all(workers);

  // 账号整体人群(按曝光人数加总)
  const overallCrowd = {};
  const overallGender = {};
  const overallAge = {};
  for (const r of results) {
    for (const c of r.audience.user_group_label_name) overallCrowd[c.label] = (overallCrowd[c.label] || 0) + c.count;
    for (const g of r.audience.gender) overallGender[g.label] = (overallGender[g.label] || 0) + g.count;
    for (const a of r.audience.age) overallAge[a.label] = (overallAge[a.label] || 0) + a.count;
  }
  const toRanked = (obj) => {
    const total = Object.values(obj).reduce((s, v) => s + v, 0) || 1;
    return Object.entries(obj).map(([label, count]) => ({ label, count, rate: count / total }))
      .sort((a, b) => b.count - a.count);
  };

  const accSuffix = accountId ? '_' + accountId : '';
  const file = path.join(AUDIENCE_CACHE_DIR, `batch_${startDate}_${endDate}_${mode}${accSuffix}.json`);
  const payload = {
    start: startDate, end: endDate, mode, accountId: accountId || 'default', count: results.length,
    results,
    overallCrowd: toRanked(overallCrowd),
    overallGender: toRanked(overallGender),
    overallAge: toRanked(overallAge),
  };
  await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');

  return { ...payload, file };
}

module.exports = { batchMaterialAudience, AUDIENCE_CACHE_DIR };

