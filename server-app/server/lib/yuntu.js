/**
 * server/lib/yuntu.js — 巨量云图(yuntu.oceanengine.com) 取数模块（纯 API）
 *
 * ★ 2026-07-02 实测推翻旧结论：云图接口**不需要签名**，cookie 即可纯 API 调用。
 *   msToken/X-Bogus/_signature 后端不校验，只是前端 JS 自动带上，可省略。
 *   之前 connectOverCDP 浏览器 attach 那套已废弃，改成纯 https + cookie。
 *
 * 日期格式坑(不同接口不同，照抓包为准)：
 *   - GetAudienceAssetStructure / GetAudienceAssetBig8Profile 的 date: 紧凑 "20260629"
 *   - AudienceFlowScene* 的 start_date/end_date: 带横线 "2026-05-31"
 *
 * 业务封装对应 REVERSE_API_YUNTU.md §4。cookie 从 scripts/yuntu_cookie.txt 读。
 */
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const https = require('https');
const { getFileSafeTimestamp, CACHE_DIR, YUNTU_ACCOUNTS } = require('./config');

const YUNTU_BASE = 'https://yuntu.oceanengine.com';
const YUNTU_CACHE_DIR = path.join(CACHE_DIR, 'yuntu');
if (!fs.existsSync(YUNTU_CACHE_DIR)) fs.mkdirSync(YUNTU_CACHE_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';

// 账号解析: 传 accountId 返回账号配置
function resolveAccount(accountId) {
  const list = YUNTU_ACCOUNTS && YUNTU_ACCOUNTS.length ? YUNTU_ACCOUNTS : [];
  if (!list.length) throw new Error('YUNTU_ACCOUNTS 未配置');
  // 2026-08-01 审计 P0：不传 accountId 静默回落 list[0] 违反"拼错的账号一律400，禁止静默回落默认 cookie"铁律（串店数据源）
  if (!accountId) throw new Error('accountId 必填（禁止静默回落默认账号）');
  const acc = list.find(a => a.id === accountId);
  if (!acc) throw new Error('未知云图账号: ' + accountId);
  return acc;
}

async function readYuntuCookie(acc) {
  // 优先读云图自己的 cookie，不存在则用该账号对应的千川 cookie（按 account.id 匹配）
  const yuntuPath = path.join(__dirname, '..', '..', 'scripts', acc.cookieFile || 'yuntu_cookie.txt');
  if (fs.existsSync(yuntuPath)) {
    const c = (await fsPromises.readFile(yuntuPath, 'utf8')).trim();
    if (!c) throw new Error('yuntu_cookie_expired');
    return c;
  }
  // fallback: 用同账号的千川 cookie（千川和云图共用登录态），避免跨账号混用
  const qcCookieFile = acc.qcCookieFile || (acc.id ? `${acc.id}_cookie.txt` : 'cookie.txt');
  const qcPath = path.join(__dirname, '..', '..', 'scripts', qcCookieFile);
  if (fs.existsSync(qcPath)) {
    const c = (await fsPromises.readFile(qcPath, 'utf8')).trim();
    if (!c) throw new Error('yuntu_cookie_expired');
    return c;
  }
  throw new Error('yuntu_cookie_expired');
}

/**
 * 纯 API 调云图接口（cookie only，无签名）。
 * @param {string} pathname 以 / 开头
 * @param {object} opts { method='GET', params={}, body=null, accountId }
 * @returns {Promise<object>} 解析后的 JSON
 */
async function fetchYuntuApi(pathname, opts = {}) {
  const { getFileSafeTimestamp, method = 'GET', params = {}, body = null, accountId } = opts;
  const acc = resolveAccount(accountId);
  const url = new URL(YUNTU_BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('aadvid', acc.aadvid);
  const referer = acc.version === 'lite'
    ? `${YUNTU_BASE}/yuntu_lite/crowd_5a_assets/crowd_distribution?aadvid=${acc.aadvid}`
    : `${YUNTU_BASE}/yuntu_brand/ecom/assets/crowd/flow?aadvid=${acc.aadvid}`;

  const cookieStr = await readYuntuCookie(acc);

  return new Promise((resolve, reject) => {
    const reqBody = body ? JSON.stringify(body) : null;
    const headers = {
      Cookie: cookieStr,
      Accept: 'application/json, text/plain, */*',
      'Referer': referer,
      'User-Agent': UA,
    };
    if (reqBody) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(reqBody);
    }
    const req = https.request(url, { method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403 || /login|passport/i.test(res.headers.location || '')) {
          return reject(new Error('yuntu_cookie_expired'));
        }
        try {
          const parsed = JSON.parse(data);
          // 登录态失效判定
          if (parsed.status === 4002 || (parsed.msg && /session id 为空/.test(parsed.msg))) {
            return reject(new Error('yuntu_cookie_expired'));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('yuntu_parse_error: ' + data.slice(0, 200)));
        }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('云图 API 超时(15s)')); });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function asyncWriteFile(name, data) {
  try {
    const stamp = getFileSafeTimestamp();
    await fsPromises.writeFile(path.join(YUNTU_CACHE_DIR, `${name}_${stamp}.json`), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('[yuntu] 缓存写入失败:', e.message);
  }
}

// ============ 业务封装（对应 REVERSE_API_YUNTU.md §4）============
// 所有函数最后一个可选参数 accountId 指定账号(默认取 YUNTU_ACCOUNTS[0])。

/** 5A 人群资产结构：a1~a5 人数+占比 + 对标。date 紧凑格式 "20260629" */
async function getAudienceAssetStructure(date, benchmark = 1, accountId) {
  const acc = resolveAccount(accountId);
  const data = await fetchYuntuApi('/yuntu_ng/api/v1/GetAudienceAssetStructure', {
    params: { industry_id: acc.industry_id, brand_id: acc.brand_id, date, card: 0, benchmark }, accountId,
  });
  await asyncWriteFile('audience_asset_structure_' + acc.id, { date, benchmark, data });
  return data;
}

/** 8大消费人群画像。date 紧凑格式 "20260629" */
async function getAudienceAssetBig8Profile(date, accountId) {
  const acc = resolveAccount(accountId);
  const data = await fetchYuntuApi('/yuntu_ng/api/v1/GetAudienceAssetBig8Profile', {
    params: { industry_id: acc.industry_id, brand_id: acc.brand_id, date, industry_typical_type: 1 }, accountId,
  });
  await asyncWriteFile('audience_asset_big8_profile_' + acc.id, { date, data });
  return data;
}

/** 人群资产趋势（按天覆盖/排名/新增流失/行业分位）。date 紧凑格式 */
async function getAudienceAssetTrend(date, benchmark = 1, accountId) {
  const acc = resolveAccount(accountId);
  const data = await fetchYuntuApi('/yuntu_ng/api/v1/get_audience_asset_trend', {
    params: { industry_id: acc.industry_id, brand_id: acc.brand_id, date, card: 0, benchmark }, accountId,
  });
  await asyncWriteFile('audience_asset_trend_' + acc.id, { date, benchmark, data });
  return data;
}

/** 人群流转场景 + 各场景流转人数。start/end 带横线 "2026-05-31" */
async function getAudienceFlowScenes(startDate, endDate, benchmark = 1, accountId) {
  const acc = resolveAccount(accountId);
  const [scenes, profile] = await Promise.all([
    fetchYuntuApi('/yuntu_ng/api/v1/AudienceFlowSceneQuery', {
      params: { industry_id: acc.industry_id, brand_id: acc.brand_id, start_date: startDate, end_date: endDate }, accountId,
    }),
    fetchYuntuApi('/yuntu_ng/api/v1/AudienceFlowSceneProfileV2', {
      params: { industry_id: acc.industry_id, brand_id: acc.brand_id, benchmark, start_date: startDate, end_date: endDate }, accountId,
    }),
  ]);
  const sceneList = (scenes.data && scenes.data.scene_list) || [];
  const analysis = {};
  for (const s of sceneList) {
    try {
      analysis[s.scene_id] = await fetchYuntuApi('/yuntu_ng/api/v1/AudienceFlowSceneAnalysisV2', {
        method: 'POST', params: { aadvid: acc.aadvid },
        body: { industry_id: parseInt(acc.industry_id, 10), brand_id: parseInt(acc.brand_id, 10), scene_id: s.scene_id, diff_a3_active: false, benchmark, start_date: startDate, end_date: endDate }, accountId,
      });
    } catch (e) { if (e.message === 'yuntu_cookie_expired') throw e; /* 单场景失败不阻塞 */ }
  }
  const result = { scenes, profile, analysis };
  await asyncWriteFile('audience_flow_scenes_' + acc.id, { startDate, endDate, benchmark, result });
  return result;
}

/**
 * 人群流转异步分析任务 FlowSceneAnalysisV2：提交→拿 id→轮询到 status:2
 * @param {string} sceneId 场景 id（如 -3 种草）
 */
async function getFlowSceneAnalysis(startDate, endDate, sceneId, level1QueryType = 1, level2QueryType = 3, accountId) {
  const acc = resolveAccount(accountId);
  const submitBody = { industry_id: acc.industry_id, brand_id: acc.brand_id, start_date: startDate, end_date: endDate, level_1_query_type: level1QueryType, level_2_query_type: level2QueryType, scene_id: sceneId, custom_audience_ids: [], features: [] };
  const submit = await fetchYuntuApi('/yuntu_ng/api/v1/FlowSceneAnalysisV2', {
    method: 'POST', params: { aadvid: acc.aadvid }, body: submitBody, accountId,
  });
  let id = submit.data && submit.data.id;
  if (!id) return submit;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const poll = await fetchYuntuApi('/yuntu_ng/api/v1/FlowSceneAnalysisV2', {
      method: 'POST', params: { aadvid: acc.aadvid }, body: { ...submitBody, id }, accountId,
    });
    if (poll.data && poll.data.status === 2) { await asyncWriteFile('flow_scene_analysis_' + acc.id, { startDate, endDate, sceneId, data: poll.data }); return poll.data; }
  }
  throw new Error(`FlowSceneAnalysisV2 轮询超时(scene=${sceneId})`);
}

/**
 * 某场景下按人群的流转明细（页面「种草场景营销策略分析」明细表）。
 * @param {string} sceneId 场景id: -1拉新/-2蓄水/-3种草/-4直接转化/-5种草转化/-6复购
 * @param {string} startDate 带横线 2026-05-31
 * @param {string} endDate   带横线 2026-06-29
 * @param {string} [accountId]
 */
async function getSceneCrowdFlow(sceneId, startDate, endDate, accountId) {
  const acc = resolveAccount(accountId);
  const r = await getFlowSceneAnalysis(startDate, endDate, sceneId, 1, 3, accountId);
  const raw = r.flow_scene_data || [];
  const crowds = raw.map(x => ({
    id: x.id,
    name: (x.name || '').replace('8大消费群体_', ''),
    flowNum: parseFloat(x.flow_num) || 0,
    flowRate: x.flow_rate || 0,
    competeFlowNum: parseFloat(x.compete_flow_num) || 0,
    competeFlowRate: x.compete_flow_rate || 0,
    diffFlowRate: x.diff_flow_rate || 0,
    diffFlowNum: x.diff_flow_num || 0,
  })).sort((a, b) => b.flowRate - a.flowRate);
  const result = { sceneId, startDate, endDate, accountId: acc.id, crowds };
  await asyncWriteFile('scene_crowd_flow_' + acc.id, result);
  return { ...result, raw: r };
}

/** 素材整体效果（有效素材数/衰减率/播放/互动/转化/GMV/ROI） */
async function getMaterialGeneralInfo(pDate, periodType = 7, triggerPointIdList = ['600000', '600200', '600203'], accountId) {
  const acc = resolveAccount(accountId);
  const data = await fetchYuntuApi('/yuntu_common/api/content/trigger_analysis/GetContentMaterialGeneralInfo', {
    method: 'POST', params: { aadvid: acc.aadvid },
    body: { industry_id_list: [acc.industry_id], industry_top: 13, trigger_point_id_list: triggerPointIdList, brand_id: acc.brand_id, assist_type: 3, assist_video_type: 2, p_date: pDate, period_type: periodType }, accountId,
  });
  await asyncWriteFile('material_general_info_' + acc.id, { pDate, periodType, data });
  return data;
}

/** 素材内容标签池（data_type: 1=成分配方 / 2=人群感受 / 3=其它待核） */
async function getMaterialTag(endDate, periodType = 7, dataType = 1, triggerPointIdList = ['600000', '600200', '600203'], accountId) {
  const acc = resolveAccount(accountId);
  const data = await fetchYuntuApi('/yuntu_common/api/content/trigger_analysis/GetContentMaterialTag', {
    method: 'POST', params: { aadvid: acc.aadvid },
    body: { date_range: { end_date: endDate, period_type: periodType }, trigger_point_id_list: triggerPointIdList, assist_type_info: { assist_type: 3, assist_video_type: 2 }, data_type: dataType, industry_id_list: [acc.industry_id] }, accountId,
  });
  await asyncWriteFile('material_tag_' + acc.id, { endDate, periodType, dataType, data });
  return data;
}

/** Top 视频素材列表 */
async function getMaterialTopVideo(startDate, endDate, periodType = 7, triggerPointIdList = ['600000', '600200', '600203'], page = 1, pageSize = 12, accountId) {
  const acc = resolveAccount(accountId);
  const data = await fetchYuntuApi('/yuntu_common/api/content/trigger_analysis/GetContentTopVideo', {
    method: 'POST', params: { aadvid: acc.aadvid },
    body: { data_type: 2, date_range: { start_date: startDate, end_date: endDate, period_type: periodType }, trigger_point_id_list: triggerPointIdList, industry_id_list: [acc.industry_id], assist_type_info: { assist_type: 3, assist_video_type: 2 }, page_info: { page: String(page), page_size: String(pageSize) }, material_tag_entry: [], price_range: [] }, accountId,
  });
  await asyncWriteFile('material_top_video_' + acc.id, { startDate, endDate, page, data });
  return data;
}

/** 人群地图（人群包目录+覆盖数+渗透率+5A覆盖+重叠数） */
async function getCrowdMap(groupTypeId = 1, accountId) {
  const acc = resolveAccount(accountId);
  const data = await fetchYuntuApi('/yuntu_biz/api/common/crowdMap/GetAudienceMap', {
    method: 'POST', params: { aadvid: acc.aadvid },
    body: { group_type_id: groupTypeId, brand_5A_industry_id: acc.industry_id }, accountId,
  });
  await asyncWriteFile('crowd_map_' + acc.id, { groupTypeId, data });
  return data;
}

module.exports = {
  fetchYuntuApi,
  resolveAccount,
  getAudienceAssetStructure,
  getAudienceAssetBig8Profile,
  getAudienceAssetTrend,
  getAudienceFlowScenes,
  getFlowSceneAnalysis,
  getSceneCrowdFlow,
  getMaterialGeneralInfo,
  getMaterialTag,
  getMaterialTopVideo,
  getCrowdMap,
};
