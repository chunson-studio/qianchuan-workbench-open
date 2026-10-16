const fs = require('fs');
const path = require('path');
const { sendJSON, readJsonBody, requireWriteAuth } = require('../lib/utils');
const { isValidAccountId } = require('../lib/api-helpers');
const decisionLedger = require('../lib/decisionLedger');
const { publicRound, isRetiredLesson } = require('../lib/decisionEvidence');

const DEFAULT_MEMORY_BASE_DIR = path.join(__dirname, '..', '..', 'agent-memory');

/** 记忆根目录：默认 agent-memory/，测试可用 AGENT_MEMORY_DIR 隔离到临时目录 */
function getMemoryBaseDir() {
  return process.env.AGENT_MEMORY_DIR || DEFAULT_MEMORY_BASE_DIR;
}

// ═══════════════════════════════════════════════════════════
// 账号隔离词表硬校验（§七-8 数据质量保障：跨账号特征词污染拦截）
// ═══════════════════════════════════════════════════════════

// 词表文件路径：config.MHS.vocab_file，空则默认项目 references/ 下（2026-08-11 审查修复：去掉 D: 盘硬编码）
const DEFAULT_VOCAB_FILE = path.join(__dirname, '..', '..', '..', 'references', '账号特征词表.md');

/**
 * 解析账号特征词表（宽松 markdown 解析）。
  * 历史账户专用说明已从试用包移除。
 * 条目取 `- `/`*`/数字列表行，行内再按 顿号/逗号/分号/斜杠 切词；单词 <2 字符丢弃（防单字误伤）。
 * 标题含账号 id 或账号中文名 → 该节词归此账号；不含任何账号 → 公共节（不拦）。
 * 同一词出现在 ≥2 个账号节 → 视为公共词（归属不明，不拦）。
 *
 * @param {string} text - 词表文件内容
 * @param {Array} accounts - [{ id, name }]
 * @returns {{ restricted: Map<string, string>, common: Set<string> }}
 *   restricted: 词 → 归属账号 id（仅归属单一账号的词，校验用）；common: 公共词
 */
function parseVocabText(text, accounts) {
  const accList = Array.isArray(accounts) ? accounts : [];
  const owners = new Map(); // word → Set<accountId>
  let currentOwner = null;  // null = 公共节

  const addWord = (word) => {
    const w = String(word || '').trim();
    if (w.length < 2) return;
    if (!owners.has(w)) owners.set(w, new Set());
    if (currentOwner) owners.get(w).add(currentOwner);
    else owners.get(w).add('__common__');
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const title = heading[1];
      const acc = accList.find(a =>
        (a.id && title.includes(a.id)) || (a.name && title.includes(a.name)));
      currentOwner = acc ? acc.id : null;
      continue;
    }
    // 列表条目：- / * / + / 数字.、) 开头；非列表行在账号节内也按词处理（宽松）
    const item = line.replace(/^(?:[-*+]|\d+[.、)）])\s*/, '');
    if (!item || item === line && /^[|>]/.test(line)) continue; // 跳过表格/引用行
    for (const w of item.split(/[、，,；;|/]+/)) addWord(w);
  }

  const restricted = new Map();
  const common = new Set();
  for (const [word, set] of owners) {
    if (set.has('__common__') || set.size !== 1) { common.add(word); continue; }
    restricted.set(word, [...set][0]);
  }
  return { restricted, common };
}

// 词表加载缓存（按 mtime 失效）；文件缺失/损坏 → 降级跳过校验，console.warn 只刷一次
let vocabCache = { path: null, mtimeMs: 0, parsed: null };
let vocabWarned = false;

function resolveVocabPath() {
  try {
    const cfg = require('../lib/config');
    return (cfg.MHS && cfg.MHS.vocab_file) || DEFAULT_VOCAB_FILE;
  } catch {
    return DEFAULT_VOCAB_FILE;
  }
}

function loadVocab() {
  const p = resolveVocabPath();
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    if (!vocabWarned) {
      console.warn(`[agent-memory] 账号特征词表缺失（${p}），跨账号词校验降级跳过（§七-8 词表由Agent维护）`);
      vocabWarned = true;
    }
    return null;
  }
  if (vocabCache.path === p && vocabCache.mtimeMs === st.mtimeMs && vocabCache.parsed) {
    return vocabCache.parsed;
  }
  try {
    const text = fs.readFileSync(p, 'utf8');
    const accounts = (require('../lib/config').QIANCHUAN_ACCOUNTS) || [];
    const parsed = parseVocabText(text, accounts);
    vocabCache = { path: p, mtimeMs: st.mtimeMs, parsed };
    return parsed;
  } catch (e) {
    if (!vocabWarned) {
      console.warn(`[agent-memory] 账号特征词表解析失败（${e.message}），跨账号词校验降级跳过`);
      vocabWarned = true;
    }
    return null;
  }
}

/**
 * 跨账号特征词检查：content 文本中出现"其他账号专属词"即命中（阈值 ≥1 即拦）。
 * 本账号词与公共词不拦。词表不可用时返回 null（降级跳过）。
 * @returns {Array<{word:string, owner:string}>|null} 命中列表；null=校验未执行
 */
function checkCrossAccountWords(account, content) {
  const vocab = loadVocab();
  if (!vocab) return null;
  const text = JSON.stringify(content);
  const hits = [];
  for (const [word, owner] of vocab.restricted) {
    if (owner !== account && text.includes(word)) hits.push({ word, owner });
  }
  return hits;
}

/**
 * 决策记录单写源（§七-8）：当天同 round 的决策文件查重。
 * 与 GET decisions 同口径合并两目录（账号目录 + 公共目录），
 * 匹配条件：文件名当天（UTC，与写入命名一致）且 record.round 相同且 record.account 与本次写入 scope 相同。
 * @returns {string|null} 已存在的文件名；无重复返回 null
 */
function findSameRoundDecision(paths, account, round) {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const dirs = account
    ? [paths.decisions, path.join(getMemoryBaseDir(), 'decisions')]
    : [paths.decisions];
  const seen = new Set();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json') || !f.startsWith(todayPrefix) || seen.has(f)) continue;
      seen.add(f);
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        if (String(rec.round) === String(round) && (rec.account || null) === (account || null)) {
          return f;
        }
      } catch { /* 损坏文件跳过 */ }
    }
  }
  return null;
}

/**
 * 按账号获取记忆目录路径（多账号隔离）。
 * 不传 account 时保持向后兼容：使用 agent-memory/ 根目录。
 * @param {string} [account] - 账号ID
 * @returns {{dir: string, decisions: string, lessons: string, context: string}}
 * @throws {Error} account 格式非法时抛出
 */
function getMemoryPaths(account) {
  if (account && !isValidAccountId(account)) {
    const err = new Error(`account_invalid: ${account}`);
    err.statusCode = 400;
    throw err;
  }
  const dir = account ? path.join(getMemoryBaseDir(), account) : getMemoryBaseDir();
  const paths = {
    dir,
    decisions: path.join(dir, 'decisions'),
    lessons: path.join(dir, 'lessons'),
    context: path.join(dir, 'context.json'),
  };
  // 确保目录存在
  [paths.dir, paths.decisions, paths.lessons].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  return paths;
}

/**
 * GET /api/agent-memory?type=decisions&limit=10   — 读最近N轮决策记录
 * GET /api/agent-memory?type=lessons               — 读经验教训
 * GET /api/agent-memory?type=context               — 读上一轮快照（用于环比对比）
 * POST /api/agent-memory                            — 写入决策记录或经验
 *   body: { type: "decision"|"lesson"|"context", content: {...} }
 * PUT  /api/agent-memory?type=lesson&id=xxx        — 更新经验教训
 */
async function handleAgentMemory(req, res, url) {
  try {
    const method = req.method;
    const account = url.searchParams.get('account') || undefined;
    const paths = getMemoryPaths(account);

  // ===== GET: 读记忆 =====
  if (method === 'GET') {
    const type = url.searchParams.get('type') || 'decisions';

    if (type === 'context') {
      // 读上一轮快照
    if (fs.existsSync(paths.context)) {
      try {
        const ctx = JSON.parse(fs.readFileSync(paths.context, 'utf8'));
        return sendJSON(res, { ok: true, account, context: ctx });
      } catch (e) {
        console.error('[agent-memory] context.json 解析失败:', e.message);
        return sendJSON(res, { ok: true, account, context: null, msg: '历史快照解析失败，已忽略' });
      }
    }
      return sendJSON(res, { ok: true, account, context: null, msg: '尚无历史快照，这是第一轮' });
    }

    if (type === 'lessons') {
      if (isRetiredLesson(url.searchParams.get('id'))) return sendJSON(res, {
        ok: false, code: 'decision_scoring_retired', retryable: false,
        error: '自动评分经验已退出读取入口，历史文件保留供审计。',
      }, 410);
      // 带 account 时合并两目录：公共=跨账号通用规律，账号=专属经验；同 id 以账号版为准（后写覆盖）
      const dirs = account ? [path.join(getMemoryBaseDir(), 'lessons'), paths.lessons] : [paths.lessons];
      const byId = new Map();
      for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d).filter(f => f.endsWith('.md')).sort()) {
          if (isRetiredLesson(f)) continue;
          byId.set(f.replace('.md', ''), fs.readFileSync(path.join(d, f), 'utf8'));
        }
      }
      // 历史账户专用说明已从试用包移除。
      if ((url.searchParams.get('mode') || '') === 'titles') {
        const titles = [...byId.entries()].map(([id, content]) => {
          const lines = String(content).split('\n').map(s => s.trim()).filter(Boolean);
          const title = (lines.find(l => l.startsWith('#')) || lines[0] || id).replace(/^#+\s*/, '');
          return { id, title };
        }).sort((a, b) => b.id.localeCompare(a.id));
        return sendJSON(res, { ok: true, account, mode: 'titles', count: titles.length, lessons: titles });
      }
      // id 参数：只取单篇全文（配合 mode=titles 索引后按需取）
      const wantId = url.searchParams.get('id');
      if (wantId) {
        const content = byId.get(wantId);
        if (content == null) return sendJSON(res, { ok: false, error: `lesson 不存在: ${wantId}` }, 404);
        return sendJSON(res, { ok: true, account, lessons: [{ id: wantId, content }] });
      }
      const lessons = [...byId.entries()].map(([id, content]) => ({ id, content }))
        .sort((a, b) => b.id.localeCompare(a.id));
      return sendJSON(res, { ok: true, account, count: lessons.length, lessons });
    }

    if (type === 'decisions') {
      if (!account) return sendJSON(res, { ok: false, code: 'account_required', error: '读取决策记录必须指定account' }, 400);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
      await decisionLedger.importLegacyDecisions(account);
      const decisions = decisionLedger.listRounds(account, { limit }).map(publicRound);
      return sendJSON(res, { ok: true, account, count: decisions.length, decisions });
    }

    return sendJSON(res, { ok: false, error: 'Unknown type. Use: decisions, lessons, context' }, 400);
  }

  // ===== POST: 写记忆 =====
  if (method === 'POST') {
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);

    const { type, content } = data;
    if (!type || !content) {
      return sendJSON(res, { ok: false, error: 'Missing type or content' }, 400);
    }
    // content 大小限制（防止恶意写入大量数据）
    const contentSize = JSON.stringify(content).length;
    if (contentSize > 1024 * 1024) { // 1MB
      return sendJSON(res, { ok: false, error: 'content too large (max 1MB)' }, 400);
    }

    // 账号隔离词表硬校验（§七-8）：带 account 的写入不得出现其他账号专属特征词（≥1 个即拦）。
    // 词表缺失/损坏时 loadVocab 返回 null → 降级跳过（已 console.warn 一次）。
    if (account && (type === 'decision' || type === 'lesson' || type === 'context')) {
      const hits = checkCrossAccountWords(account, content);
      if (hits && hits.length > 0) {
        return sendJSON(res, {
          ok: false,
          error: `跨账号特征词命中，拒绝写入（写入账号 ${account}，命中 ${hits.length} 个其他账号专属词）`,
          hits,
        }, 400);
      }
    }

    const ts = new Date();
    const tsStr = ts.toISOString().replace(/[:.]/g, '-');

    if (type === 'decision') {
      if (!account) return sendJSON(res, { ok: false, code: 'account_required', error: '写入决策记录必须指定account' }, 400);
      const saved = decisionLedger.recordRound(account, content, {
        strictSession: false,
        legacy: !content.session_key,
        recordedAt: ts.toISOString(),
      });
      return sendJSON(res, {
        ok: true,
        account,
        msg: saved.duplicate ? '决策记录已存在，幂等返回' : '决策记录已保存',
        duplicate: saved.duplicate,
        round_id: saved.round.round_id,
        session_key: saved.round.session_key,
      });
    }

    if (type === 'lesson') {
      // 写经验教训
      const id = content.id || `lesson_${tsStr}`;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) return sendJSON(res, { ok: false, error: 'Invalid lesson id' }, 400);
      const fileName = `${id}.md`;
      const header = `# ${content.title || id}\n> 记录时间: ${ts.toISOString()}\n> 账号: ${account || '(全局)'}\n\n`;
      fs.writeFileSync(path.join(paths.lessons, fileName), header + (content.body || ''), 'utf8');
      return sendJSON(res, { ok: true, account, msg: '经验教训已保存', file: fileName, id });
    }

    if (type === 'context') {
      // 写当前轮快照（供下一轮环比对比）
      fs.writeFileSync(paths.context, JSON.stringify({ account: account || null, ...content }, null, 2), 'utf8');
      return sendJSON(res, { ok: true, account, msg: '上下文快照已更新' });
    }

    return sendJSON(res, { ok: false, error: 'Unknown type. Use: decision, lesson, context' }, 400);
  }

    return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  } catch (e) {
    if (Number.isInteger(e.statusCode) && e.statusCode >= 400 && e.statusCode < 500) {
      return sendJSON(res, { ok: false, code: e.code || 'invalid_request', error: e.message }, e.statusCode);
    }
    if (e.code === 'SQLITE_BUSY') {
      return sendJSON(res, { ok: false, code: 'db_busy', error: '决策账本暂时繁忙，请稍后重试', retryable: true }, 503);
    }
    console.error('[agent-memory] 异常:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

module.exports = handleAgentMemory;
// 导出 memory 路径解析函数供其他模块复用
module.exports.getMemoryPaths = getMemoryPaths;
module.exports.checkCrossAccountWords = checkCrossAccountWords;
// 测试钩子：词表解析/跨账号校验/同轮查重（§七-8）
module.exports._test = {
  parseVocabText,
  checkCrossAccountWords,
  findSameRoundDecision,
  getMemoryBaseDir,
  resetVocabCache: () => { vocabCache = { path: null, mtimeMs: 0, parsed: null }; vocabWarned = false; },
};
