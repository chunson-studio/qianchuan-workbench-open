const fs = require('fs');
const path = require('path');
const { sendJSON, formatDate } = require('../lib/utils');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'agent-memory', 'reports');

/**
  * 历史账户专用说明已从试用包移除。
 *
 * 读取夜间任务生成的素材洞察报告。
 * 不传 date 时默认返回最近一份；不传 account 时返回所有账号。
 */
function handleInsights(req, res, url) {
  try {
    let date = url.searchParams.get('date');
    const account = url.searchParams.get('account');

    if (!fs.existsSync(REPORTS_DIR)) {
      return sendJSON(res, { ok: true, date: date || null, reports: [], available_dates: [], message: '还没有生成过素材洞察报告' });
    }

    const files = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.startsWith('insights_') && f.endsWith('.json'))
      .sort();

    if (files.length === 0) {
      return sendJSON(res, { ok: true, date: date || null, reports: [], available_dates: [], message: '还没有生成过素材洞察报告' });
    }

    // 不传日期时取最新的日期
    if (!date) {
      const latest = files[files.length - 1];
      const m = latest.match(/insights_([a-zA-Z0-9_-]+)_(\d{4}-\d{2}-\d{2})\.json/);
      if (m) date = m[1];
    }

    const prefix = account ? `insights_${account}_${date}.json` : `insights_`;
    const matched = files
      .filter(f => f.includes(`_${date}.json`) && (account ? f === prefix : true))
      .map(f => {
        const p = path.join(REPORTS_DIR, f);
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          return { ok: true, ...data };
        } catch (e) {
          return { ok: false, file: f, error: e.message };
        }
      });

    if (matched.length === 0) {
      return sendJSON(res, { ok: true, date, reports: [], available_dates: [], message: `未找到 ${date} 的洞察报告` });
    }

    return sendJSON(res, {
      ok: true,
      date,
      reports: matched,
      available_dates: [...new Set(files.map(f => {
        const m = f.match(/_(\d{4}-\d{2}-\d{2})\.json/);
        return m ? m[1] : null;
      }).filter(Boolean))].sort().reverse().slice(0, 30),
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[insights] error:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

module.exports = handleInsights;
