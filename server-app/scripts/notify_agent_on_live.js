'use strict';

// 私有首轮试用不绑定维护者会话，也不启动通知任务。
function startWatcher() { return { stop() {} }; }
function activeAccountIds() { return []; }
module.exports = { startWatcher, activeAccountIds };
