/**
 * liveBoardCore.js — 大屏请求体构造公共模块
 *
 * live-collect（纯 API）和 server.liveBoard（浏览器）共享此模块，
 * 千川接口结构变更时只需改这里。
 */
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'cache');
const TEMPLATES_FILE_CACHE = path.join(CACHE_DIR, 'live_board_templates', 'templates.json');
const TEMPLATES_FILE_BUNDLED = path.join(__dirname, 'liveBoardTemplates.json');

let _templates = null;

/**
 * 加载大屏模板。优先 cache/ 最新抓包版，没有则回退入库版本。
 */
function loadTemplates() {
  if (_templates) return _templates;
  const file = fs.existsSync(TEMPLATES_FILE_CACHE) ? TEMPLATES_FILE_CACHE : TEMPLATES_FILE_BUNDLED;
  if (!fs.existsSync(file)) {
    throw new Error('大屏模板不存在，请先跑 tools/captures/capture_live_board_templates.js');
  }
  _templates = JSON.parse(fs.readFileSync(file, 'utf8')).templates;
  return _templates;
}

/**
 * 基于模板构建 statQuery 请求体。
 * @param {string} reqFrom — 模块名（init/commonMetricCard/...）
 * @param {string} roomId
 * @param {string} [anchorId] — 主播 ID；缺失时剔除 anchor_id 过滤条件（不下发字符串 'undefined'，由 room_id 兜底过滤）
 * @param {string} aavid — 广告主 ID
 * @param {string} [liveStartTime] — 开播时间 "YYYY-MM-DD HH:MM:SS"
 * @param {string} [liveEndTime] — 下播时间；不传则用当前时间
 * @param {Object} [pageParams] — 分页参数 { Offset, Limit }
 */
function buildBody(reqFrom, roomId, anchorId, aavid, liveStartTime, liveEndTime, pageParams) {
  const tpl = loadTemplates()[reqFrom];
  if (!tpl) throw new Error('未知大屏模块: ' + reqFrom);
  const body = JSON.parse(JSON.stringify(tpl));

  const conds = body.Filters && body.Filters.Conditions;
  if (conds) {
    // anchorId 缺失（如 init 失败未取到）时剔除 anchor_id 条件，避免下发字符串 'undefined'
    body.Filters.Conditions = conds.filter(c =>
      c.Field !== 'anchor_id' || (anchorId !== undefined && anchorId !== null && anchorId !== ''));
    for (const c of body.Filters.Conditions) {
      if (c.Field === 'advertiser_id') c.Values = [aavid];
      else if (c.Field === 'room_id') c.Values = [roomId];
      else if (c.Field === 'anchor_id') c.Values = [String(anchorId)];
    }
  }

  if (body.aavid !== undefined) body.aavid = aavid;
  if (liveStartTime && body.StartTime !== undefined) body.StartTime = liveStartTime;
  if (body.EndTime !== undefined) {
    if (liveEndTime) {
      body.EndTime = liveEndTime;
    } else {
      const d = new Date();
      body.EndTime = d.getFullYear() + '-'
        + String(d.getMonth() + 1).padStart(2, '0') + '-'
        + String(d.getDate()).padStart(2, '0') + ' '
        + String(d.getHours()).padStart(2, '0') + ':'
        + String(d.getMinutes()).padStart(2, '0') + ':'
        + String(d.getSeconds()).padStart(2, '0');
    }
  }

  if (pageParams) body.PageParams = pageParams;
  body.reqFrom = reqFrom;
  return body;
}

/**
 * 从 statQuery 响应中提取 rows 和 totals
 */
function extract(result) {
  const sd = result && result.data && result.data.StatsData;
  return { rows: (sd && sd.Rows) || [], totals: (sd && sd.Totals) || {} };
}

module.exports = { loadTemplates, buildBody, extract };
