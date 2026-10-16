/**
 * 实时素材看板：千川 API 直连，拉取在投素材从上传日起的累计表现
  * 历史账户专用说明已从试用包移除。
 */

const { fetchAllData, normalizeApiRows, enrichRows } = require('../lib/data');
const { fetchUniPromAdList } = require('../lib/qianchuanTabs');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, getLocalDateStr, cacheKey } = require('../lib/utils');
const { createTTLCache } = require('../lib/cache');
const { defaultAccountId } = require('../lib/api-helpers');

const memCache = createTTLCache(2 * 60 * 1000); // 2 分钟内存缓存（90天累计数据变化不大）

async function handleMaterialsNow(req, res, url) {
  const account = url.searchParams.get('account') || defaultAccountId();
  const refresh = url.searchParams.get('refresh') === '1';
  const full = url.searchParams.get('full') === '1'; // 2026-08-04 token 优化：默认裁剪，full=1 返回完整字段

  // Cookie 校验
  if (!isCookieProbablyValid(readQcCookie(account))) {
    return sendJSON(res, { ok: false, error: 'cookie_expired', hint: 'Cookie 已失效，请先刷新（重新导出 cookie.txt 或运行 qc_cookie_refresher）' }, 401);
  }

  const key = account + '|' + (refresh ? 'refresh' : 'normal') + (full ? '|full' : '|slim');
  const mem = memCache.get(key);
  if (!refresh && mem) {
    console.log(`[materials-now] ✓ 内存缓存命中 (${account})`);
    return sendJSON(res, { ok: true, ...mem, from_cache: true });
  }

  // 默认拉 90 天全量（覆盖绝大多数素材的完整生命周期）
  const end = getLocalDateStr();
  const d90 = new Date();
  d90.setDate(d90.getDate() - 90);
  const start = getLocalDateStr(d90);

  console.log(`[materials-now] 拉取 ${start}~${end} (${account})`);

  try {
    const t0 = Date.now();
    // 并行拉取素材数据 + 计划列表（用于 operation 权限信息）
    const [result, adListResult] = await Promise.all([
      fetchAllData(start, end, account),
      fetchUniPromAdList(end, end, account).catch(e => {
        console.log(`[materials-now] 计划列表拉取失败: ${e.message}`);
        return null;
      }),
    ]);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // 解析计划列表的 operation 权限，按 ad_id 建索引
    const planOps = {};
    if (adListResult && adListResult.data && adListResult.data.adInfos) {
      for (const ad of adListResult.data.adInfos) {
        const op = ad.operation || {};
        const assist = ad.assistTaskAggInfo || {};
        planOps[String(ad.id)] = {
          ad_name: ad.name,
          ad_delivery_name: ad.adDeliveryName,       // 投放状态名（如"投放中"）
          ecp_roi2_goal: ad.ecpRoi2Goal,             // 预估ROI目标
          roi2_goal: ad.deepExternalAction,           // 深度优化目标
          budget: ad.budget,                          // 预算
          learning_phase: ad.learningPhase,           // 学习期状态
          qcpx_mode: ad.qcpxMode,                     // 智能优惠券
          // 操作权限
          can_edit_roi: !!(op.roi2GoalOperation && op.roi2GoalOperation.editable),
          can_edit_budget: !!(op.budgetEditOperation && op.budgetEditOperation.editable),
          can_edit_status: !!(op.optStatusOperation && op.optStatusOperation.editable),
          can_edit_plan: !!(op.editOperation && op.editOperation.editable),
          can_revive: !!(op.reviveOperation && op.reviveOperation.revivable),
          // 追投任务
          assist_visible: !!(assist.create && assist.create.visible),
          assist_editable: !!(assist.create && assist.create.editable),
          assist_reason: assist.create && assist.create.reason || '',
        };
      }
      console.log(`[materials-now] 计划列表: ${adListResult.data.adInfos.length} 个计划，已解析 operation 权限`);
    }

    if (!result || !result.rows || result.rows.length === 0) {
      return sendJSON(res, { ok: true, data: [], meta: { total: 0, elapsed }, server_time: new Date().toISOString() });
    }

    // 标准化 + 分类
    const normalized = normalizeApiRows(result.rows);
    const enriched = enrichRows(normalized, start, end);

    // 给每条素材附加计划级 operation 权限
    enriched.forEach(r => {
      const adId = String(r['计划ID'] || '');
      if (adId && planOps[adId]) {
        r._plan = planOps[adId];
      }
    });

    // 过滤已删除
    const active = enriched.filter(r => r['状态'] !== '已删除');

    // 按 _action 分组（投手可直接执行的操作）
    const groups = {
      delist:      active.filter(r => r._action === 'delist'),
      watch:       active.filter(r => r._action === 'watch' || r._action === 'cold'),
      boost_roi:   active.filter(r => r._action === 'boost_roi'),
      boost_open:  active.filter(r => r._action === 'boost_open'),
      pause_boost: active.filter(r => r._action === 'pause_boost'),
      raise_roi:   active.filter(r => r._action === 'raise_roi'),
    };

    // 摘要统计
    const summary = {
      total: active.length,
      deleted: enriched.length - active.length,
      totalCost: active.reduce((s, r) => s + (Number(r['整体消耗(元)']) || 0), 0),
      totalGMV: active.reduce((s, r) => s + (Number(r['整体成交金额(元)']) || 0), 0),
      stageDistribution: {},
      actionDistribution: {},
      qualityCount: 0,
      tags: {},
    };

    active.forEach(r => {
      const s = r._stage || '?';
      summary.stageDistribution[s] = (summary.stageDistribution[s] || 0) + 1;
      const a = r._action || '?';
      summary.actionDistribution[a] = (summary.actionDistribution[a] || 0) + 1;
      if (r._isQuality) summary.qualityCount++;
      (r._tags || []).forEach(t => {
        summary.tags[t] = (summary.tags[t] || 0) + 1;
      });
    });

    summary.overallROI = summary.totalCost > 0
      ? (summary.totalGMV / summary.totalCost).toFixed(2)
      : '—';

    console.log(`[materials-now] ✓ ${active.length} 条在投素材，${elapsed}s`);

    const out = {
      meta: {
        ...summary,
        window: `${start} ~ ${end}`,
        elapsed: `${elapsed}s`,
        truncated: result.truncated || false,
      },
      groups: {
        delist: groups.delist.sort((a, b) => (Number(b['整体消耗(元)']) || 0) - (Number(a['整体消耗(元)']) || 0)),
        watch: groups.watch.sort((a, b) => (Number(b['整体消耗(元)']) || 0) - (Number(a['整体消耗(元)']) || 0)),
        boost_roi: groups.boost_roi.sort((a, b) => (Number(b['整体消耗(元)']) || 0) - (Number(a['整体消耗(元)']) || 0)),
        boost_open: groups.boost_open.sort((a, b) => (Number(b['整体消耗(元)']) || 0) - (Number(a['整体消耗(元)']) || 0)),
        pause_boost: groups.pause_boost.sort((a, b) => (Number(b['整体消耗(元)']) || 0) - (Number(a['整体消耗(元)']) || 0)),
        raise_roi: groups.raise_roi.sort((a, b) => (Number(b['整体消耗(元)']) || 0) - (Number(a['整体消耗(元)']) || 0)),
      },
      server_time: new Date().toISOString(),
    };
    // 2026-08-04 token 优化：决策组（watch/boost_roi/boost_open/pause_boost/raise_roi）裁剪到盯盘必需字段，
    // 砍掉视频点赞/评论/观看时长/完播率等 34 个盯盘无用字段（约省 68%）。
    // delist 组保留完整字段（删素材需 adId/objectId/legoMids 等完整上下文）。
    if (!full) {
      const SLIM_FIELDS = ['素材ID', '素材名称', '整体消耗(元)', '净成交金额(元)', '整体成交订单数', '1h退款率', '_netROI', '_stage', '_action', '_plan', '_tags', '_isQuality', '_days'];
      const SLIM_GROUPS = ['watch', 'boost_roi', 'boost_open', 'pause_boost', 'raise_roi'];
      for (const k of SLIM_GROUPS) {
        if (Array.isArray(out.groups[k])) {
          out.groups[k] = out.groups[k].map(item => Object.fromEntries(SLIM_FIELDS.filter(f => f in item).map(f => [f, item[f]])));
        }
      }
    }
    memCache.set(key, out);
    return sendJSON(res, { ok: true, ...out });
  } catch (e) {
    console.log(`[materials-now] ✗ ${e.message}`);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialsNow;
