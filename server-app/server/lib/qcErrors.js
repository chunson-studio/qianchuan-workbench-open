/**
 * 千川写操作错误码映射表。
 * 用于操作日志 result_msg，让投手能看懂失败原因。
 */
const QC_ERROR_CODES = {
  0: '成功',
  2: '请求限频，请稍后重试',
  3001: '参数校验失败（ROI/预算值不合法或任务信息不完整）',
  3026: 'Audience 定向字段不全（需原样回传完整 Audience 对象，含 city/age/areaReverse 等地域定向字段）',
  40002: '路径权限校验失败（verifyFp缺失或计划状态不允许操作）',
  8092: '素材校验失败（部分素材不可投，已自动过滤重试）',
  401: '登录已过期，请刷新cookie',
  40001: '登录已过期，请刷新cookie',
};

/**
  * 历史账户专用说明已从试用包移除。
 * rate_limit=限频 / cookie=登录态 / param=参数 / permission=权限 / material=素材 / unknown=未分类
 */
const QC_ERROR_CATEGORY = {
  0: 'ok',
  2: 'rate_limit',
  3001: 'param',
  3026: 'param',
  40002: 'permission',
  8092: 'material',
  401: 'cookie',
  40001: 'cookie',
};

/**
 * 根据千川API响应生成可读的错误消息。
 * @param {object} result - 千川API原始响应
 * @returns {string} 可读的错误描述
 */
function describeResult(result) {
  if (!result) return '无响应';
  const sc = result.status_code ?? result.code;
  if (sc == null || sc === 0) return null; // 成功时返回null
  const msg = result.message || QC_ERROR_CODES[sc] || `未知错误码 ${sc}`;
  // 如果有 failedReason（素材校验失败详情），附加
  if (result.data && result.data.failedReason) {
    const failedIds = Object.keys(result.data.failedReason);
    if (failedIds.length > 0) {
      return `${msg}（不可投素材: ${failedIds.join(',')}）`;
    }
  }
  return msg;
}

/** 取错误分类（agent 程序化分流用；未在表内的 code 归 unknown） */
function categoryOf(result) {
  const sc = result && (result.status_code ?? result.code);
  if (sc == null) return 'unknown';
  return QC_ERROR_CATEGORY[sc] || 'unknown';
}

module.exports = { QC_ERROR_CODES, QC_ERROR_CATEGORY, describeResult, categoryOf };
