'use strict';

// 私有首轮试用不启动人群画像调度。
function startScheduler() { return { stop() {} }; }
module.exports = { startScheduler };
