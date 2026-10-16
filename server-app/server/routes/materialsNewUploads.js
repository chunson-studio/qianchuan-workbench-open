const { sendJSON } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');
const creativeVideoLibrary = require('../lib/creativeVideoLibrary');
const dbLib = require('../lib/db');
const { createTTLCache } = require('../lib/cache');

// 5 分钟内存缓存
const cache = createTTLCache(5 * 60 * 1000);

async function handleMaterialsNewUploads(req, res, url) {
  try {
    const accountParam = url.searchParams.get('account') || url.searchParams.get('accountId');
    const accountId = validateAccount(accountParam);

    let days = parseInt(url.searchParams.get('days'), 10);
    if (isNaN(days) || days <= 0) days = 7;
    if (days > 30) days = 30; // 上限30天

    const cacheKey = `${accountId}|${days}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return sendJSON(res, cachedData);
    }

    const now = new Date();
    const cutoffDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // 早停分页拉取（2026-08-02 验收修复：fetchAll 无约束全量 20 页过限频队列，接口挂死 60s 超时）
    // video-list 按 create_time 降序——本页最旧一条已越窗则后续页只会更旧，立即停
    const newVideos = [];
    {
      let page = 1, stop = false;
      while (!stop && page <= 5) { // days≤30 窗口，5页×100 足够覆盖两店月上传量
        const batch = await creativeVideoLibrary.fetchPage(accountId, { page, pageSize: 100 });
        for (const v of batch.videos) {
          const createTime = new Date(v.create_time.replace(' ', 'T'));
          if (createTime >= cutoffDate) newVideos.push(v);
        }
        const pageOldest = batch.videos.length ? new Date(batch.videos[batch.videos.length - 1].create_time.replace(' ', 'T')) : null;
        if (!pageOldest || pageOldest < cutoffDate || !batch.hasMore) stop = true;
        else page++;
      }
    }

    if (newVideos.length === 0) {
      const responseData = {
        ok: true,
        account: accountId,
        days,
        total: 0,
        items: []
      };
      cache.set(cacheKey, responseData);
      return sendJSON(res, responseData);
    }

    const materialIds = newVideos.map(v => v.material_id);
    const db = dbLib.getDB();
    
    // Chunking to avoid SQLite bind limit if length > 900
    const costMap = new Map();
    const chunkSize = 500;
    for (let i = 0; i < materialIds.length; i += chunkSize) {
      const chunk = materialIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const stmt = db.prepare(`
        SELECT material_id, SUM(cost) as total_cost
        FROM material_daily
        WHERE account_id = ? AND material_id IN (${placeholders})
        GROUP BY material_id
      `);
      const rows = stmt.all(accountId, ...chunk);
      for (const row of rows) {
        costMap.set(row.material_id, row.total_cost);
      }
    }

    const items = newVideos.map(v => {
      const dbCost = costMap.get(v.material_id) || 0;
      let status = '未开跑';
      if (dbCost >= 100) {
        status = '已开跑';
      } else if (dbCost > 0) {
        status = '探量中';
      }

      return {
        material_id: v.material_id,
        name: v.name,
        create_time: v.create_time,
        status,
        lib_stats: {
          cost: v.cost,
          roi2: v.roi2,
          cvr: v.cvr,
          ctr: v.ctr
        },
        db_cost_7d: dbCost
      };
    });

    items.sort((a, b) => new Date(b.create_time.replace(' ', 'T')) - new Date(a.create_time.replace(' ', 'T')));

    const responseData = {
      ok: true,
      account: accountId,
      days,
      total: items.length,
      items
    };

    cache.set(cacheKey, responseData);
    return sendJSON(res, responseData);

  } catch (e) {
    if (e.statusCode === 400) {
      return sendJSON(res, { ok: false, error: e.message }, 400);
    }
    console.error('materialsNewUploads error:', e);
    return sendJSON(res, { ok: false, error: '服务器内部错误' }, 500);
  }
}

// 导出 handle 以及 cache，方便测试清空缓存
module.exports = {
  handleMaterialsNewUploads,
  _testCache: cache
};
