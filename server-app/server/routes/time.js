const { sendJSON } = require('../lib/utils');

/**
 * GET /api/time
 * 返回当前最权威的北京时间时间戳与 ISO 字符串，防止 Agent 汇报或冷却倒计时出现时间错乱。
 */
function handleTime(req, res) {
  const now = new Date();
  const beijingTimeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const [datePart, timePart] = beijingTimeStr.split(' ');
  const [year, month, day] = datePart.split('/');
  const formattedDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const formattedTime = timePart ? timePart.substring(0, 5) : '00:00';

  sendJSON(res, {
    ok: true,
    timestamp: now.getTime(),
    iso: now.toISOString(),
    beijing_time: beijingTimeStr,
    formatted_date: formattedDate,
    formatted_time: formattedTime,
    hour: parseInt(formattedTime.split(':')[0], 10),
    minute: parseInt(formattedTime.split(':')[1], 10)
  });
}

module.exports = handleTime;
