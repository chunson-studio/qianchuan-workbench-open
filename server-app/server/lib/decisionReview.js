'use strict';

// 旧调用方只得到退役声明，不能把未评分误当作 0 分或没有动作。
function retired() {
  return { ok: false, code: 'decision_scoring_retired', retryable: false,
    message: '自动事后评分已退役；请读取操作台账和同场前后事实。' };
}
module.exports = { reviewOperations: retired, reviewDay: retired };
