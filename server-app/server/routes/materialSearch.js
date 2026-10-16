// server/routes/materialSearch.js
// 通过素材名字或 materialId 搜索素材ID与累计数据
const { sendJSON } = require('../lib/utils');
const { getRangeHistory } = require('../lib/db');
const cv = require('../lib/creativeVideoLibrary');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/material-search?account=xxx&name=稻草扎肉&source=video-library&start=2026-07-01&end=2026-07-24
 *
 * source 可选：
 *   - 不传 / db：从 material_history.db 按请求区间搜索直播素材（平台1h净成交口径）
 *   - video-library：从千川视频库接口搜索，返回全渠道累计消耗/roi2（直播+商品卡+乘方）
 *
  * 历史账户专用说明已从试用包移除。
 */
async function handleMaterialSearch(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  const account = url.searchParams.get('account') || url.searchParams.get('accountId');
  const name = (url.searchParams.get('name') || '').trim();
  if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
  if (!name || name.length < 2) return sendJSON(res, { ok: false, error: 'name 至少 2 个字' }, 400);

  const source = (url.searchParams.get('source') || 'db').toLowerCase();

  // video-library 源：全渠道累计口径
  if (source === 'video-library') {
    const today = new Date().toISOString().slice(0, 10);
    const start = url.searchParams.get('start') || url.searchParams.get('startDate') || today;
    const end = url.searchParams.get('end') || url.searchParams.get('endDate') || today;
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      return sendJSON(res, { ok: false, error: 'start/end 格式须为 YYYY-MM-DD' }, 400);
    }
    try {
      const matches = await cv.searchByTitle(account, name, { startDate: start, endDate: end });
      const list = matches.map(v => ({
        material_id: v.material_id,
        name: v.name,
        cost_total: v.cost,
        roi2: v.roi2,
        ctr: v.ctr,
        cvr: v.cvr,
        create_time: v.create_time,
        source: 'video-library',
      })).sort((a, b) => b.cost_total - a.cost_total);
      return sendJSON(res, { ok: true, account, name, source, start, end, count: list.length, matches: list });
    } catch (e) {
      console.error('[materialSearch video-library] error:', e.message);
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  // DB查询尊重日期和直播渠道；不混入实时快照或商品卡。
  const { daysAgo, getLocalDateStr } = require('../lib/utils');
  const start = url.searchParams.get('start') || url.searchParams.get('startDate') || daysAgo(89);
  const end = url.searchParams.get('end') || url.searchParams.get('endDate') || getLocalDateStr();
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || start > end) {
    return sendJSON(res, { ok: false, error: 'invalid_date_range' }, 400);
  }
  try {
    const normalize = s => String(s || '').replace(/^\d+月\d+日\s*/, '').replace(/\.mp4$/i, '').replace(/\s+/g, '');
    const isId = /^\d{10,}$/.test(name), key = normalize(name);
    const matches = new Map();
    for (const row of getRangeHistory(start, end, account)) {
      if (Number(row.marketing_goal) !== 2) continue;
      const id = String(row.material_id || '');
      if (!id || id === '__EMPTY__') continue;
      if (isId ? id !== name : !normalize(row.material_name).includes(key)) continue;
      let item = matches.get(id);
      if (!item) {
        item = { material_id: id, name: row.material_name || '', cost_total: 0, net_gmv_total: 0, net_data_valid: true, cost_data_valid: true, source: 'db' };
        matches.set(id, item);
      }
      if (row.cost == null) item.cost_data_valid = false;
      else item.cost_total += Number(row.cost);
      if (row.net_gmv_1h == null) item.net_data_valid = false;
      else item.net_gmv_total += Number(row.net_gmv_1h);
    }
    const list = [...matches.values()].map(m => ({
      ...m, cost_total: m.cost_data_valid ? +m.cost_total.toFixed(2) : null,
      net_gmv_total: m.net_data_valid ? +m.net_gmv_total.toFixed(2) : null,
      roi: m.cost_data_valid && m.net_data_valid && m.cost_total > 0 ? +(m.net_gmv_total/m.cost_total).toFixed(2) : null,
      roi_basis: 'platform_net_1h', value_source: 'derived_from_daily',
    })).sort((a,b) => b.cost_total-a.cost_total);
    return sendJSON(res, { ok: true, account, name, source: 'db', start, end, marketing_goal: 2,
      roi_basis: 'platform_net_1h', count: list.length, matches: list });
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialSearch;
