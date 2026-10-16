const { sendJSON, readJsonBody } = require('../lib/utils');

const MAX_LOG_LEN = 2000;
function truncate(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) + '...(truncated)' : s;
}

async function handleLog(req, res) {
  if (req.method !== 'POST') return sendJSON(res, { error: 'method not allowed' }, 405);
  const { data: logData, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { error: error.message }, error.status || 400);
  console.log(`\n🚨 [浏览器端报错] ----------------------------`);
  console.log(`消息: ${truncate(logData.message, MAX_LOG_LEN)}`);
  if (logData.url) console.log(`文件: ${truncate(logData.url, 500)}:${logData.line || ''}:${logData.col || ''}`);
  if (logData.stack) console.log(`堆栈:\n${truncate(logData.stack, MAX_LOG_LEN)}`);
  console.log(`---------------------------------------------\n`);
  sendJSON(res, { ok: true });
}

module.exports = handleLog;
