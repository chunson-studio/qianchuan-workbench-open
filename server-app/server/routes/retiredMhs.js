'use strict';

const { sendJSON } = require('../lib/utils');

// 保留退役回执，防旧 Agent 将 404 当成取数故障而重试或重启服务。
// 不读取数据库、版本文件，也不允许重新激活评分。
module.exports = function handleRetiredMhs(req, res) {
  return sendJSON(res, {
    ok: false,
    code: 'mhs_retired',
    retryable: false,
    error: 'MHS 综合评分与评分动作建议已退役；请使用真实指标和账户策略判断。',
    replacements: {
      watch: '/api/live-summary',
      material_evidence: '/api/live-cockpit',
      material_history: '/api/material-lifecycle',
    },
  }, 410);
};
