const { getAccountBalance, getAccountDailyBudget } = require('../lib/qianchuan');
const { sendJSON } = require('../lib/utils');
const { createTTLCache } = require('../lib/cache');

// 余额/日预算 60s TTL 缓存（交付版 E2E 实测回流：原每调直拉 2~5.7s，暖调用降到毫秒级）
const balanceCache = createTTLCache(60 * 1000);
const dailyBudgetCache = createTTLCache(60 * 1000);

/**
 * GET /api/balance?account=xxx
 * 返回千川账户余额信息。
 *
 * 返回字段：
 *   - total_balance_yuan: 总余额（元）
 *   - valid_balance_yuan: 可用余额（元）
 *   - frozen_balance_yuan: 冻结余额（元）
 *   - wallets: 各钱包明细
 *     - advBalanceType: 1=千川通用钱包, 2=小钱包, 9=共享钱包
 *     - total/valid/frozen: 金额（分）
 */
async function handleBalance(req, res, url) {
  const account = url ? url.searchParams.get('account') : null;

  const ck = `bal:${account || 'default'}`;
  const hit = balanceCache.get(ck);
  if (hit) return sendJSON(res, { ...hit, from_cache: true });

  try {
    const raw = await getAccountBalance(account);
    const balanceInfos = (raw && raw.data && raw.data.balanceInfos) || {};

    // 解析各钱包
    const wallets = [];
    let totalFen = 0, validFen = 0, frozenFen = 0;

    // 千川余额单位：1元 = 100000（页面显示 36283.07 元 = 返回 3628306000）
    const UNIT_TO_YUAN = 100000;

    const WALLET_NAMES = { '1': '千川通用钱包', '2': '小钱包', '9': '共享钱包', '10': '共享钱包2', '11': '共享钱包3' };

    // type 1/9/10/11 是同一笔钱的不同视图，只取 type 1 作为主余额
    const PRIMARY_TYPE = '1';

    for (const [type, info] of Object.entries(balanceInfos)) {
      const t = parseInt(info.total, 10) || 0;
      const v = parseInt(info.valid, 10) || 0;
      const f = parseInt(info.frozen, 10) || 0;
      wallets.push({
        type: parseInt(type, 10),
        name: WALLET_NAMES[type] || `钱包${type}`,
        total_fen: t,
        valid_fen: v,
        frozen_fen: f,
        total_yuan: +(t / UNIT_TO_YUAN).toFixed(2),
        valid_yuan: +(v / UNIT_TO_YUAN).toFixed(2),
        frozen_yuan: +(f / UNIT_TO_YUAN).toFixed(2),
      });
      // 只累加 type 1 和 type 2（小钱包是独立的），跳过 9/10/11（和1重复）
      if (type === PRIMARY_TYPE || type === '2') {
        totalFen += t;
        validFen += v;
        frozenFen += f;
      }
    }

    const payload = {
      ok: true,
      account: account || 'default',
      total_balance_yuan: +(totalFen / UNIT_TO_YUAN).toFixed(2),
      valid_balance_yuan: +(validFen / UNIT_TO_YUAN).toFixed(2),
      frozen_balance_yuan: +(frozenFen / UNIT_TO_YUAN).toFixed(2),
      wallets,
      raw,
      server_time: new Date().toISOString(),
    };
    balanceCache.set(ck, payload);
    return sendJSON(res, payload);
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleBalance;
module.exports.handleBalance = handleBalance;

/**
 * GET /api/daily-budget?account=xxx
 * 返回千川账户日预算信息。
 *
 * 返回字段（根据千川接口返回结构解析）：
 *   - ok: 是否成功
 *   - account: 账号ID
 *   - daily_budget: 日预算（元，若接口返回分则换算）
 *   - raw: 原始响应
 */
async function handleDailyBudget(req, res, url) {
  const account = url ? url.searchParams.get('account') : null;

  const ck = `db:${account || 'default'}`;
  const hit = dailyBudgetCache.get(ck);
  if (hit) return sendJSON(res, { ...hit, from_cache: true });

  try {
    const raw = await getAccountDailyBudget(account);

    // 尝试从常见字段中提取日预算
    let dailyBudget = null;
    if (raw && raw.data) {
      // 可能的字段名：budget / daily_budget / day_budget（单位可能是微或元）
      const d = raw.data;
      if (d.budget != null) dailyBudget = d.budget;
      else if (d.daily_budget != null) dailyBudget = d.daily_budget;
      else if (d.day_budget != null) dailyBudget = d.day_budget;
      else if (d.account_budget != null) dailyBudget = d.account_budget;

      // 千川金额单位是微（1元=100000微），无条件换算
      if (dailyBudget != null) {
        dailyBudget = Number(dailyBudget) / 100000;
      }
    }

    const payload = {
      ok: true,
      account: account || 'default',
      daily_budget: dailyBudget,
      raw,
    };
    dailyBudgetCache.set(ck, payload);
    return sendJSON(res, payload);
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports.handleDailyBudget = handleDailyBudget;
