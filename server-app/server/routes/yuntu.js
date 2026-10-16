const { sendJSON, yesterday: yesterdayStr, daysAgoDate, getLocalDateStr } = require('../lib/utils');
const yuntu = require('../lib/yuntu');

/**
 * 云图人群数据路由:
 *   GET /api/yuntu-distribution?date=20260629      A1-A5结构 + 8大人群画像(分布页)
 *   GET /api/yuntu-flow?start=&end=                流转场景总人数(流转页上半)
 *   GET /api/yuntu-scene-crowd?sceneId=&start=&end=  某场景按8大人群流转明细(流转页下半)
 *
 * date 参数: distribution 用紧凑 20260629; flow/scene-crowd 用带横线 2026-05-31。
 * 不传 date 默认昨天。cookie 失效返回 yuntu_cookie_expired。
  * 历史账户专用说明已从试用包移除。
 */
async function handleYuntu(req, res, url) {
  const pathname = url.pathname;
  const account = url.searchParams.get('account') || undefined;
  const yesterday = yesterdayStr();
  const yesterdayCompact = yesterday.replace(/-/g, '');

  try {
    // 分布页: A1-A5 结构 + 8大人群
    if (pathname === '/api/yuntu-distribution') {
      const date = url.searchParams.get('date') || yesterdayCompact;
      const [structure, big8] = await Promise.all([
        yuntu.getAudienceAssetStructure(date, 1, account),
        yuntu.getAudienceAssetBig8Profile(date, account),
      ]);
      return sendJSON(res, { ok: true, date, account: account || 'default', structure, big8 });
    }

    // 流转页上半: 各场景流转总人数 + 行业分位
    if (pathname === '/api/yuntu-flow') {
      const end = url.searchParams.get('end') || yesterday;
      const start = url.searchParams.get('start') || (() => {
        const s = daysAgoDate(29);
        return getLocalDateStr(s);
      })();
      const benchmark = parseInt(url.searchParams.get('benchmark') || '1') || 1;
      const flow = await yuntu.getAudienceFlowScenes(start, end, benchmark, account);
      return sendJSON(res, { ok: true, start, end, benchmark, account: account || 'default', flow });
    }

    // 流转页下半: 某场景按8大人群流转明细
    if (pathname === '/api/yuntu-scene-crowd') {
      const sceneId = url.searchParams.get('sceneId') || '-3';
      const end = url.searchParams.get('end') || yesterday;
      const start = url.searchParams.get('start') || (() => {
        const s = daysAgoDate(29);
        return getLocalDateStr(s);
      })();
      const r = await yuntu.getSceneCrowdFlow(sceneId, start, end, account);
      return sendJSON(res, { ok: !r.error, ...r });
    }

    return sendJSON(res, { ok: false, error: '未知云图接口' }, 404);
  } catch (e) {
    const code = e.message === 'yuntu_cookie_expired' ? 401 : 500;
    return sendJSON(res, { ok: false, error: e.message }, code);
  }
}

module.exports = handleYuntu;
