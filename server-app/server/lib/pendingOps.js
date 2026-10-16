/**
 * pendingOps — AI 建议待确认队列（🟡 分级自治的中间层）
 *
 * K3 盯盘轮把不可逆/花钱的操作（删除追投、删除素材、创建追投）提交到这里，
 * 投手在作战室一键【执行/拒绝】。pending 超过 2 小时自动过期（不执行）。
 * 状态流转：pending → executing（approve 占位，防重复执行；超 10 分钟未完成自动回收为 failed）→ executed/failed；或 pending → rejected/expired。
 *
 * 存储：cache/pending_ops.json（小数据量，JSON 足够，无需 SQLite）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_FILE = process.env.PENDING_OPS_STORE || path.join(__dirname, '..', '..', 'cache', 'pending_ops.json');
const EXPIRE_MS = 2 * 60 * 60 * 1000; // 建议有效期 2 小时
const EXECUTING_TIMEOUT_MS = 10 * 60 * 1000; // executing 占位超时回收（进程中断兜底）
const AUTO_EXECUTE_DELAY_MS = 0; // 仅 Agent 明确授权 auto_execute 后使用；项目自身不得生成自动写入授权

// 决策来源白名单（MHS §5.1 ③）：owner_directive=人工指令直通，auto 复核跳过急性/慢性判定；
// server_guard=服务端护栏建议（2026-07-29 建议制：只检测+推送，不自动执行）
const SOURCES = ['agent', 'owner_directive', 'server_guard'];

// 类型白名单与必填参数（params 里 accountId 为公共必填，不重复列出）
const TYPES = {
  pause_boost:     { label: '暂停追投', required: ['assistTaskId'] },
  resume_boost:    { label: '恢复追投', required: ['assistTaskId'] },
  delete_boost:    { label: '删除追投', required: ['assistTaskId'] },
  delete_material: { label: '删除素材', required: ['adId', 'objectId', 'legoMids'] },
  create_boost:    { label: '创建追投', required: ['primaryAdId', 'mids', 'budget'] },
};

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (data && Array.isArray(data.items)) return data;
  } catch { /* 文件不存在或损坏 → 空库 */ }
  return { items: [] };
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// pending 超过 2 小时标记过期；executing 超过 10 分钟回收为 failed（惰性：读取时才标记并落盘）
// delete_stay=true 的建议不适用 2h 自然过期：已进入 48h 死缓状态机（MHS §5.1，routes/pendingOps.js），
// 由死缓状态机决定撤销/执行，5 天未决强制过期兜底防死条目
function expireOld(store) {
  let changed = false;
  for (const it of store.items) {
    if (it.status === 'pending' && !it.delete_stay && Date.now() - new Date(it.created_at).getTime() > EXPIRE_MS) {
      it.status = 'expired';
      it.decided_at = new Date().toISOString();
      changed = true;
    } else if (it.status === 'executing' && Date.now() - new Date(it.executing_at || it.created_at).getTime() > EXECUTING_TIMEOUT_MS) {
      it.status = 'failed';
      it.decided_at = new Date().toISOString();
      it.result = { error: '执行超时回收（进程可能中断），未执行成功' };
      changed = true;
    }
  }
  if (changed) writeStore(store);
}

function list({ account, status } = {}) {
  const store = readStore();
  expireOld(store);
  return store.items
    .filter(it => (!account || it.account === account) && (!status || it.status === status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function create({ account, type, params, reason, roundTime, autoExecute, source }) {
  const t = TYPES[type];
  if (!t) throw new Error(`unknown type: ${type}（支持：${Object.keys(TYPES).join('/')}）`);
  if (!account) throw new Error('account 必填');
  // 账号白名单：拼错账号入队后执行会打到错账号（2026-07-29 审计修复）
  const { validateAccount } = require('./api-helpers');
  validateAccount(account);
  if (!reason || !String(reason).trim()) throw new Error('reason 必填（量化依据）');
  if (source != null && !SOURCES.includes(source)) throw new Error(`source 仅支持 ${SOURCES.join('/')}（当前：${source}）`);
  const p = params || {};
  // 历史账户专用说明已从试用包移除。
  // 曾被当成"一个整串 id"（Array.isArray 判定为 false → [整串] → 查不到数据误判"消耗0"作废，卡了 9 次）。
  // 统一在入口拆成数组，下游（judgeOneMid/readback/enterDeleteStay/Profile）全部拿到数组，不用逐处改。
  // 2026-08-01 审计 P1 补：空数组视同未填——"," 规范化后得 []，会绕过下方 required 的 ==null/==='' 检查非法入队。
  for (const key of ['legoMids', 'mids']) {
    if (typeof p[key] === 'string') p[key] = p[key].split(',').map(s => s.trim()).filter(Boolean);
    if (Array.isArray(p[key]) && p[key].length === 0) p[key] = null;
  }
  if (!p.accountId) throw new Error('params.accountId 必填');
  // account 与 params.accountId 劈叉时：熔断按 account 计数、执行却按 params.accountId 打另一个账号（2026-07-29 审计修复）
  if (p.accountId !== account) throw new Error(`account 与 params.accountId 不一致（${account} ≠ ${p.accountId}）`);
  for (const k of t.required) {
    if (p[k] == null || p[k] === '') throw new Error(`params.${k} 必填（${t.label}）`);
  }
  // create_boost 额外校验：非控成本出价（smartBidType !== 7）时 ROI 目标必填，否则千川创建会被拒
  if (type === 'create_boost' && p.smartBidType !== 7 && (p.ecpRoi2Goal == null || p.ecpRoi2Goal === '')) {
    throw new Error('params.ecpRoi2Goal 必填（创建追投：smartBidType≠7 非控成本出价时必须指定 ROI 目标）');
  }
  // auto_execute 仅开放给 Agent 已经做出判断的 delete_material；项目诊断不得自行设置。
  if (autoExecute && type !== 'delete_material') {
    throw new Error('auto_execute 仅支持 delete_material（2026-07-29 维护者拍板：其余写操作全部建议制，收归Agent盯盘轮）');
  }
  const store = readStore();
  const now = Date.now();
  const item = {
    id: 'po_' + crypto.randomBytes(6).toString('hex'),
    account,
    type,
    type_label: t.label,
    params: p,
    reason: String(reason),
    source: source || 'agent',
    round_time: roundTime || null,
    status: 'pending',
    created_at: new Date(now).toISOString(),
    decided_at: null,
    result: null,
  };
  if (autoExecute) {
    item.auto_execute = true;
    item.auto_execute_at = new Date(now + AUTO_EXECUTE_DELAY_MS).toISOString();
  }
  store.items.push(item);
  // 只保留最近 200 条，防文件无限增长
  if (store.items.length > 200) store.items = store.items.slice(-200);
  writeStore(store);
  return item;
}

function get(id) {
  const store = readStore();
  expireOld(store);
  return store.items.find(it => it.id === id) || null;
}

function update(id, patch) {
  const store = readStore();
  const item = store.items.find(it => it.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  writeStore(store);
  return item;
}

module.exports = { TYPES, SOURCES, list, create, get, update, AUTO_EXECUTE_DELAY_MS };
