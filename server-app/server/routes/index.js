const handleSparkline = require('./sparkline');
const handleData = require('./data');
const handleOverview = require('./overview');
const handleStatus = require('./status');
const handleCollectorRecovery = require('./collectorRecovery');
const handleVersion = require('./version');
const { handleCampaignStatus, handleCampaignBudget, handleCampaignMaterials } = require('./campaignOps');
const handleMaterialLifetime = require('./materialLifetime');
const handleMaterialAudience = require('./materialAudience');
const handleMaterialRefund = require('./materialRefund');
const handleLive = require('./live');
const handleMaterialDetail = require('./materialDetail');
const handleMaterialReport = require('./materialReport');
const handleMaterialSearch = require('./materialSearch');
const { handleVideoLibrary, handleSummary } = require('./materialVideoLibrary');
const handleYuntu = require('./yuntu');
const handleLog = require('./log');
const handleMaterialsNow = require('./materialsNow');
const handleMaterialsLive = require('./materialsLive');
const { handleMaterialsNewUploads } = require('./materialsNewUploads');
const { handleTodaySnapshot } = require('./todaySnapshot');
const handleBalance = require('./balance');
const handleBoostList = require('./boostList');
const handleLiveDiagnosis = require('./liveDiagnosis');
const handleHomeStat = require('./homeStat');
const handleUpgradeAd = require('./upgradeAd');
const handleOpLog = require('./opLog');
const handleMaterialDelete = require('./materialDelete');
const handleMaterialRename = require('./materialRename');
const handleMaterialAdd = require('./materialAdd');
const handleBoostCreate = require('./boostCreate');
const handleFlowControl = require('./flowControl');
const handleBoostData = require('./boostData');
const handleLiveReplay = require('./liveReplay');
const handleLiveBoardDetail = require('./liveBoardDetail');
const handleLiveDashboard = require('./liveDashboard');
const handleLiveSummary = require('./liveSummary');
const handleBrowserSnapshot = require('./browserSnapshot');
const handleBrowserBoost = require('./browserBoost');
const handleOfflineReports = require('./offlineReports');
const handleLiveTrend = require('./liveTrend');
const handleBackfillStatus = require('./backfillStatus');
const handleHomeSplit = require('./homeSplit');
const handleAgentRounds = require('./agentRounds');
const handleDecisionRounds = require('./decisionRounds');
const handleMaterialLifecycle = require('./materialLifecycle');
const handleMaterialHourly = require('./materialHourly');
const handleAgentMemory = require('./agentMemory');
const handleTime = require('./time');
const { handleDoudianOverview, handleDoudianSummary, handleDoudianContent } = require('./doudian');
const handleMaterialInsights = require('./materialInsights');
const handleAccounts = require('./accounts');
const { handleAccountDiscover, handleAccountPreflight } = handleAccounts;
const handleConfig = require('./config');
const handleDiagnose = require('./diagnose');
const handleInsights = require('./insights');
const handleCpaQuota = require('./cpaQuota');
const handlePendingOps = require('./pendingOps');
const handleMaterialProfile = require('./materialProfile');
const handleMaterialContentRefresh = require('./materialContentRefresh');
const handleCompass = require('./compass');
const handleV4Overview = require('./v4Overview');
const handleWorkbenchSnapshot = require('./workbenchSnapshot');
const handleRetiredMhs = require('./retiredMhs');
const handleChengfang = require('./chengfang');
const handleHealthCheck = require('./healthCheck');
const { handleLiveCockpit } = require('./liveCockpit');
const { PORT } = require('../lib/config');
const { sendJSON } = require('../lib/utils');
const { isValidAccountId } = require('../lib/api-helpers');
const fs = require('fs');
const path = require('path');

/**
 * 全局读接口鉴权（可选）。
 * 仅当 config.json 配置了 read_api_token 时才启用。
 * localhost/127.0.0.1 来源自动豁免。
 * @returns {boolean} 是否通过鉴权
 */
function requireReadAuth(req) {
  try {
    const config = require('../lib/config');
    const token = config.READ_API_TOKEN;
    if (!token) return true; // 未配置令牌则放行

    // localhost 来源豁免
    const origin = req.headers.origin || '';
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return true;

    const authHeader = req.headers.authorization || '';
    const apiToken = req.headers['x-api-token'] || '';
    if (authHeader === `Bearer ${token}` || apiToken === token) return true;
    return false;
  } catch {
    return true; // 配置读取失败时放行，避免锁死
  }
}

// === 静态资源/特殊端点 handler（也走 Map 路由，保持一致性） ===

// 页面后缀路由：旧页面路径一律 302 到 v4 对应 tab（setupRoutes 内 V4_MAP）
// （2026-07-30 审计清理：旧前端 app.html 及其加载链已整体删除，原 handleAppHtml/appHtmlCache 死代码移除）
const PAGE_ROUTES = new Set(['/', '/zonglan', '/zhibo', '/huifang', '/jilu', '/monitor', '/sucai', '/replay', '/diagnose', '/reports', '/zuozhanshi', '/sucai-assets', '/system']);

// v4 新前端入口：开发期每次请求现读，改完刷新即生效，不用重启服务
function handleV4Index(req, res) {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'v4', 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  } catch (e) {
    return sendJSON(res, { error: 'v4/index.html not found' }, 500);
  }
}

// 静态文件：app.css / app.js
function handleStaticAsset(req, res, url, pathname) {
  const filePath = path.join(__dirname, '..', 'public', pathname.slice(1));
  const CT = {
    '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  };
  const ext = path.extname(pathname).toLowerCase();
  const ct = CT[ext] || 'application/octet-stream';
  const isText = ['.css', '.html', '.js', '.svg'].includes(ext);
  try {
    const data = isText ? fs.readFileSync(filePath, 'utf-8') : fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': isText ? ct + '; charset=utf-8' : ct,
      'Cache-Control': 'no-cache, must-revalidate', // 开发期强制浏览器重新验证，不改文件也走 304
    });
    return res.end(data);
  } catch (e) {
    return sendJSON(res, { error: 'File not found: ' + pathname }, 404);
  }
}

// /log?file=xxx 读取日志文件（供监控页面用）
function handleLogFile(req, res, url) {
  const filename = url.searchParams.get('file');
  // 白名单：只允许 rebackfill_*.log 格式的文件名
  if (!filename || !/^rebackfill_[a-zA-Z0-9_-]+\.log$/.test(filename)) {
    return sendJSON(res, { error: 'invalid filename' }, 400);
  }
  const logPath = path.join(__dirname, '..', '..', 'logs', filename);
  // 路径遍历防御：resolve 后必须仍在 logs 目录内
  const resolved = path.resolve(logPath);
  const logsDir = path.resolve(__dirname, '..', '..', 'logs');
  if (!resolved.startsWith(logsDir + path.sep) && resolved !== logsDir) {
    return sendJSON(res, { error: 'invalid filename' }, 400);
  }
  try {
    const text = fs.readFileSync(logPath, 'utf-8');
    // 附带 mtime，供前端判断日志是否停滞（进程已死但页面仍显示"进行中"）
    const mtimeMs = fs.statSync(logPath).mtimeMs;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Log-Mtime': String(Math.round(mtimeMs)),
    });
    return res.end(text);
  } catch (e) {
    return sendJSON(res, { error: 'file not found' }, 404);
  }
}

// 遗留浏览器探针已移除；保留明确的退役响应。
async function handleProbe(_req, res) {
  return sendJSON(res, { ok: false, code: 'browser_probe_retired',
    message: '旧浏览器探针已移除；本地 CDP 请使用独立 playwright-cdp 绑定入口。', advertising_writes: 0 }, 410);
}

// P20: 路由表 — Map 查找替代 if-else 链
// 历史账户专用说明已从试用包移除。
// 历史账户专用说明已从试用包移除。
// 维护规则：路由新增/改参数时同步本表；未注册的路由默认放行（渐进覆盖，宁不拦勿误拦）。
const ROUTE_PARAMS = new Map(Object.entries({
  '/api/sparkline': ['account', 'accountId', 'dateRange', 'days'],
  '/api/data': ['account', 'accountId', 'start', 'end', 'refresh', 'check'],
  '/api/overview': ['account', 'start', 'end', 'dateRange', 'refresh'],
  '/api/campaign/materials': ['account', 'adId', 'start', 'end'],
  '/api/status': ['account'],
  '/health/data': ['account', 'room_id', 'start_time'],
  '/api/collector/recover': ['account', 'room_id', 'start_time'],
  '/api/version': [],
  '/api/workbench-snapshot': ['account'],
  '/health': [],
  '/api/health-check': [],
  '/api/material-lifetime': ['account', 'id', 'createTime', 'start', 'end', 'dateRange'],
  '/api/material-hourly': ['account', 'accountId', 'material_id', 'materialId', 'id', 'start', 'end', 'startDate', 'endDate', 'name'],
  '/api/material-audience': ['account', 'start', 'end', 'dateRange', 'mode', 'minCost', 'concurrency', 'refresh'],
  '/api/material-refund': ['account', 'start', 'end', 'dateRange', 'minCost'],
  '/api/material-detail': ['account', 'id', 'start', 'end', 'dateRange'],
  '/api/material-report': ['account', 'id', 'start', 'end', 'dateRange', 'format'],
  '/api/material-search': ['account', 'accountId', 'name', 'source', 'start', 'end', 'startDate', 'endDate'],
  '/api/live-status': ['account', 'date', 'dateRange', 'status', 'roomId', 'anchorId', 'endTime'],
  '/api/live-sessions': ['account', 'date', 'dateRange', 'status', 'roomId', 'anchorId', 'endTime'],
  '/api/live-board': ['account', 'date', 'dateRange', 'status', 'roomId', 'anchorId', 'endTime'],
  '/api/live-collect': ['account', 'date', 'dateRange', 'status', 'roomId', 'anchorId', 'endTime'],
  '/api/live-watch': ['account', 'date', 'dateRange', 'status', 'roomId', 'room_id', 'start_time', 'anchorId', 'endTime'],
  '/api/yuntu-distribution': ['account', 'date'],
  '/api/yuntu-flow': ['account', 'start', 'end', 'benchmark'],
  '/api/yuntu-scene-crowd': ['account', 'start', 'end', 'sceneId'],
  '/api/today-snapshot': ['account'],
  '/api/materials/now': ['account', 'refresh', 'full'],
  '/api/materials/live': ['account', 'refresh', 'status', 'pageSize', 'start', 'end', 'startDate', 'endDate', 'date'],
  '/api/materials/new-uploads': ['account', 'accountId', 'days'],
  '/api/materials/video-library': ['account', 'accountId', 'start', 'end', 'startDate', 'endDate', 'query', 'q', 'queryString', 'page', 'pageSize', 'id', 'material_id', 'materialId'],
  '/api/materials/summary': ['account', 'accountId', 'start', 'end', 'startDate', 'endDate', 'query', 'q', 'queryString', 'page', 'pageSize', 'id', 'material_id', 'materialId'],
  '/api/balance': ['account'],
  '/api/daily-budget': ['account'],
  '/api/boost-list': ['account', 'accountId', 'adId', 'start', 'end', 'includeAllStatus', 'marGoal'],
  '/api/flow-control': ['account', 'accountId', 'primaryAdId', 'primary_ad_id'],
  '/api/live-diagnosis': ['account'],
  '/api/time': [],
  '/api/home-stat': ['account'],
  '/api/upgrade-ad': ['account'],
  '/api/op-log': ['stats', 'start', 'end', 'startDate', 'endDate', 'limit', 'offset', 'action', 'accountId', 'adId', 'effectStatus'],
  '/api/boost-overview': ['account', 'assistAid', 'anchorId', 'adId', 'aggAid', 'primaryAdId', 'start', 'end', 'startDate', 'endDate'],
  '/api/boost-trend': ['account', 'assistAid', 'anchorId', 'adId', 'aggAid', 'primaryAdId', 'start', 'end', 'startDate', 'endDate'],
  '/api/boost-material-detail': ['account', 'assistAid', 'anchorId', 'adId', 'aggAid', 'primaryAdId', 'start', 'end', 'startDate', 'endDate', 'session_key', 'slim'],
  '/api/boost-support': ['account', 'assistAid', 'anchorId', 'adId', 'aggAid', 'primaryAdId', 'start', 'end', 'startDate', 'endDate'],
  '/api/boost-opt-log': ['account', 'assistAid', 'anchorId', 'adId', 'aggAid', 'primaryAdId', 'start', 'end', 'startDate', 'endDate'],
  '/api/boost-suggest-roi': ['account', 'assistAid', 'anchorId', 'adId', 'aggAid', 'primaryAdId', 'start', 'end', 'startDate', 'endDate'],
  '/api/live-replay': ['account', 'date', 'refresh', 'roomId', 'startTime', 'endTime', 'include_boost_history'],
  '/api/offline-reports': ['account', 'mode', 'report_id', 'scope', 'entity_id', 'start', 'end', 'limit', 'offset', 'include_raw'],
  '/api/live-board-detail': ['account', 'roomId', 'startTime', 'endTime', 'digest', 'view', 'limit'],
  '/api/live-replay/sessions': ['account', 'date', 'start', 'end', 'refresh', 'roomId', 'startTime', 'endTime'],
  '/api/live-dashboard': ['account', 'accountId', 'full', 'slim', 'room_id', 'roomId', 'start_time'],
  '/api/live-summary': ['account', 'accountId', 'room_id', 'start_time', 'include_boosts'],
  '/api/browser-snapshot': ['account', 'accountId', 'snapshot_id'],
  '/api/browser-boost': [],
  '/api/live-trend': ['account', 'accountId'],
  '/api/live-cockpit': ['account', 'accountId', 'limit', 'slot', 'slim'],
  '/api/backfill-status': ['account', 'accountId'],
  '/api/home-split': ['account', 'accountId', 'date', 'trend', 'quick'],
  '/api/agent-rounds': ['account', 'accountId', 'session_key', 'before', 'limit'],
  '/api/decision-rounds': ['account', 'accountId', 'session_key', 'before', 'limit'],
  '/api/material-lifecycle': ['account', 'accountId'],
  '/api/material-hourly': ['account', 'accountId', 'material_id', 'materialId', 'id', 'name', 'start', 'end', 'startDate', 'endDate'],
  '/api/agent-memory': ['account', 'type', 'mode', 'id', 'limit'],
  '/api/doudian/overview': ['account', 'start', 'end'],
  '/api/doudian/summary': ['account', 'start', 'end'],
  '/api/doudian/content': ['account', 'start', 'end', 'index'],
  '/api/material-insights': ['account', 'type'],
  '/api/material-profile': ['account', 'days', 'material_id'],
  '/api/material-content-refresh': ['account', 'material_id'],
  '/api/audience-insight': ['account', 'days', 'material_id'],
  '/api/boost-time-analysis': ['account', 'days', 'start', 'end'],
  '/api/accounts': [],
  '/api/onboarding': ['account_id'],
  '/api/config': ['account', 'room_id'],
  '/api/diagnose': ['account'],
  '/api/insights': ['account', 'date'],
  '/api/pending-ops': ['account', 'status'],
  '/api/cpa-quota': [],
  '/api/log': [],
  '/api/compass': ['account', 'accountId', 'fresh'],
  '/api/compass/refresh': ['account', 'accountId'],
  '/api/compass/cookie-status': ['account', 'accountId'],
  '/api/compass/goods': ['account', 'accountId', 'range', 'fresh'],
  '/api/compass/screen': ['account', 'accountId', 'fresh', 'room_id', 'start_time'],
  '/api/compass/product-detail': ['account', 'accountId', 'roomId', 'productId'],
  '/api/compass/live-orders': ['account', 'accountId', 'roomId', 'orderStatus', 'page'],
  '/api/v4-overview': ['account', 'accountId', 'include_slow'],
  '/api/material-scorecards': ['account', 'date', 'mode', 'top_n'],
  '/api/agent-round-view': ['account', 'mode'],
  '/api/creator-brief': ['account'],
  '/api/mhs/versions': ['account', 'a', 'b'],
  '/api/mhs/versions/diff': ['account', 'a', 'b'],
  '/api/chengfang/overview': ['account', 'date', 'ad_id', 'start', 'end', 'mar_goal'],
  '/api/chengfang/live': ['account', 'date', 'ad_id', 'start', 'end', 'mar_goal'],
  '/api/chengfang/dashboard': ['account', 'date', 'section'],
  '/api/chengfang/products': ['account', 'date', 'ad_id'],
  '/api/probe': ['account', 'url'],
  '/log': ['file'],
}));
// 通用参数（前端缓存破坏/链路标记，永远放行）
const COMMON_PARAMS = new Set(['_', 't', 'ts']);
// accountId 与 account 等价共存：前端用 accountId='' 占位抑制 V4.api 自动补账号（"查全部账号"模式），
// 所有含 account 的白名单统一补 accountId（2026-08-01 端到端冒烟抓包：live-watch/agent-memory/status 被误拦 400）
for (const params of ROUTE_PARAMS.values()) {
  if (params.includes('account') && !params.includes('accountId')) params.push('accountId');
}
// 历史账户专用说明已从试用包移除。
const PARAM_ALIAS = { startDate: 'start', endDate: 'end' };

const routes = new Map([
  ['/api/sparkline', handleSparkline],
  ['/api/data', handleData],
  ['/api/overview', handleOverview],
  ['/api/campaign/status', handleCampaignStatus],
  ['/api/campaign/budget', handleCampaignBudget],
  ['/api/campaign/materials', handleCampaignMaterials],
  ['/api/status', handleStatus],
  ['/health/data', handleCollectorRecovery],
  ['/api/collector/recover', handleCollectorRecovery],
  ['/api/version', handleVersion],
  ['/api/workbench-snapshot', handleWorkbenchSnapshot],
  ['/api/health-check', handleHealthCheck],
  ['/health/live', (req, res) => sendJSON(res, {
    ok: true,
    component: 'http_process',
    boost_runner_contract: 2,
    execution_runtime_id: require('../lib/boostExecutionOwner').runtimeIdentity(require('../lib/config').RUNTIME_DATA_ROOT),
    entrypoint_id: require('../../scripts/start-workbench').entryIdentity(require('node:path').resolve(__dirname, '../../server.js')),
    pid: process.pid,
    uptime_s: Math.floor(process.uptime()),
    rss_bytes: process.memoryUsage().rss,
    timestamp: new Date().toISOString(),
  })],
  ['/health', (req, res) => {
    // 轻量存活探针：仅检查进程存活和数据库可访问性，不依赖千川 API
    let dbOk = 'ok';
    try {
      const { getDB } = require('../lib/db');
      getDB().prepare('SELECT 1').get();
    } catch (e) {
      dbOk = 'error: ' + e.message;
    }
    // 2026-08-11 backlog 检修：备份成败状态（nightTasks.backupDatabase 写 cache/backup_state.json）
    let backup = 'never';
    try {
      const statePath = path.join(__dirname, '..', '..', 'cache', 'backup_state.json');
      if (fs.existsSync(statePath)) backup = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch { /* 读不到保持 never */ }
    return sendJSON(res, {
      ok: true,
      uptime: Math.floor(process.uptime()),
      db: dbOk,
      backup,
      timestamp: new Date().toISOString(),
    });
  }],
  ['/api/material-lifetime', handleMaterialLifetime],
  ['/api/material-hourly', require('./materialHourly')],
  ['/api/material-audience', handleMaterialAudience],
  ['/api/material-refund', handleMaterialRefund],
  ['/api/material-detail', handleMaterialDetail],
  ['/api/material-report', handleMaterialReport],
  ['/api/material-search', handleMaterialSearch],
  ['/api/live-status', handleLive],
  ['/api/live-sessions', handleLive],
  ['/api/live-board', handleLive],
  ['/api/live-collect', handleLive],
  ['/api/live-watch', handleLive],
  ['/api/yuntu-distribution', handleYuntu],
  ['/api/yuntu-flow', handleYuntu],
  ['/api/yuntu-scene-crowd', handleYuntu],
  ['/api/log', handleLog],
  ['/api/today-snapshot', handleTodaySnapshot],
  ['/api/materials/now', handleMaterialsNow],
  ['/api/materials/live', handleMaterialsLive],
  ['/api/materials/new-uploads', handleMaterialsNewUploads],
  ['/api/materials/video-library', handleVideoLibrary],
  ['/api/materials/summary', handleSummary],
  ['/api/balance', handleBalance],
  ['/api/daily-budget', (req, res, url) => require('./balance').handleDailyBudget(req, res, url)],
  ['/api/boost-list', handleBoostList],
  ['/api/live-diagnosis', handleLiveDiagnosis],
  ['/api/time', handleTime],
  ['/api/home-stat', handleHomeStat],
  ['/api/upgrade-ad', handleUpgradeAd],
  ['/api/op-log', handleOpLog],
  ['/api/material/delete', handleMaterialDelete],
  ['/api/material/rename', handleMaterialRename],
  ['/api/material/add', handleMaterialAdd],
  ['/api/boost-create', handleBoostCreate],
  ['/api/flow-control', handleFlowControl],
  ['/api/boost-overview', handleBoostData],
  ['/api/boost-trend', handleBoostData],
  ['/api/boost-material-detail', handleBoostData],
  ['/api/boost-support', handleBoostData],
  ['/api/boost-delete', handleBoostData],
  ['/api/boost-opt-log', handleBoostData],
  ['/api/boost-suggest-roi', handleBoostData],
  ['/api/live-replay', handleLiveReplay],
  ['/api/live-board-detail', handleLiveBoardDetail],
  ['/api/live-replay/sessions', handleLiveReplay],
  ['/api/live-dashboard', handleLiveDashboard],
  ['/api/live-summary', handleLiveSummary],
  ['/api/browser-snapshot', handleBrowserSnapshot],
  ['/api/browser-boost', handleBrowserBoost],
  ['/api/offline-reports', handleOfflineReports],
  ['/api/live-trend', handleLiveTrend],
  ['/api/live-cockpit', handleLiveCockpit],
  ['/api/backfill-status', handleBackfillStatus],
  ['/api/home-split', handleHomeSplit],
  ['/api/agent-rounds', handleAgentRounds],
  ['/api/decision-rounds', handleDecisionRounds],
  ['/api/material-lifecycle', handleMaterialLifecycle],
  ['/api/material-hourly', handleMaterialHourly],
  ['/api/agent-memory', handleAgentMemory],
  ['/api/doudian/overview', handleDoudianOverview],
  ['/api/doudian/summary', handleDoudianSummary],
  ['/api/doudian/content', handleDoudianContent],
  ['/api/material-insights', handleMaterialInsights],
  ['/api/material-profile', handleMaterialProfile],
  ['/api/material-content-refresh', handleMaterialContentRefresh],
  ['/api/audience-insight', handleMaterialProfile],
  ['/api/boost-time-analysis', (req, res) => sendJSON(res, { ok: false, code: 'boost_time_analysis_retired', retryable: false, error: '追投时段效果已移除。' }, 410)],
  ['/api/accounts', handleAccounts],
  ['/api/onboarding', require('./onboarding')],
  ['/api/accounts/discover', handleAccountDiscover],
  ['/api/config', handleConfig],
  ['/api/diagnose', handleDiagnose],
  ['/api/insights', handleInsights],
  ['/api/pending-ops', handlePendingOps],
  ['/api/pending-ops/approve', handlePendingOps],
  ['/api/pending-ops/reject', handlePendingOps],
  ['/api/cpa-quota', handleCpaQuota],
  ['/api/compass', handleCompass],
  ['/api/compass/refresh', handleCompass],
  ['/api/compass/cookie-status', handleCompass],
  ['/api/v4-overview', handleV4Overview],
  ['/api/compass/ask', handleCompass],
  ['/api/compass/goods', handleCompass],
  ['/api/compass/videos', handleCompass],
  ['/api/compass/screen', handleCompass],
  ['/api/compass/product-detail', handleCompass],
  ['/api/compass/live-orders', handleCompass],
  ['/api/material-scorecards', handleRetiredMhs],
  ['/api/agent-round-view', require('./agentRoundView')],
  ['/api/creator-brief', require('./creatorBrief')],
  ['/api/mhs/versions', handleRetiredMhs],
  ['/api/mhs/versions/activate', handleRetiredMhs],
  ['/api/mhs/versions/diff', handleRetiredMhs],
  ['/api/chengfang/overview', handleChengfang],
  ['/api/chengfang/live', handleChengfang],
  ['/api/chengfang/dashboard', handleChengfang],
  ['/api/chengfang/products', handleChengfang],
  ['/api/probe', handleProbe],
  ['/log', handleLogFile],
  ['/manifest.json', (req, res, url) => handleStaticAsset(req, res, url, '/manifest.json')],
  ['/sw.js', (req, res, url) => handleStaticAsset(req, res, url, '/sw.js')],
  ['/icon.svg', (req, res, url) => handleStaticAsset(req, res, url, '/icon.svg')],
]);

function setupRoutes(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS 预检请求直接返回（白名单模式）
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    const allowedOrigins = (() => {
      try {
        const config = require('../lib/config');
        if (Array.isArray(config.ALLOWED_ORIGINS)) return config.ALLOWED_ORIGINS;
      } catch {}
      return ['http://localhost:18991', 'http://127.0.0.1:18991'];
    })();
    const allowedOrigin = (origin && allowedOrigins.includes(origin)) ? origin : allowedOrigins[0];
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-token',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  const deadlineMs = pathname === '/health/data' && url.searchParams.has('room_id')
    ? 30000
    : pathname === '/health/live' || pathname === '/health/data'
    ? 3000
    : pathname === '/api/collector/recover'
      ? 65000
    : (pathname === '/api/live-status' || pathname === '/api/live-watch')
      ? 25000
      : 55000;
  const requestController = new AbortController();
  req.signal = requestController.signal;
  req.deadlineMs = deadlineMs;
  const timeoutError = Object.assign(new Error(`HTTP 请求超过 ${deadlineMs}ms`), {
    code: 'request_timeout', component: 'http', retryable: true,
    statusCode: 504, timeoutMs: deadlineMs,
  });
  const deadlineTimer = setTimeout(() => {
    if (res.writableEnded) return;
    requestController.abort(timeoutError);
    if (!res.headersSent) {
      sendJSON(res, {
        ok: false,
        error: timeoutError.message,
        code: timeoutError.code,
        component: timeoutError.component,
        retryable: true,
        timeout_ms: deadlineMs,
        partial: false,
        errors: [],
      }, 504);
    } else {
      res.destroy(timeoutError);
    }
  }, deadlineMs);
  deadlineTimer.unref?.();
  const cleanupDeadline = () => clearTimeout(deadlineTimer);
  res.once('finish', cleanupDeadline);
  res.once('close', () => {
    cleanupDeadline();
    if (!res.writableEnded && !requestController.signal.aborted) {
      requestController.abort(Object.assign(new Error('HTTP 客户端连接已关闭'), {
        code: 'client_closed', component: 'http', retryable: true,
      }));
    }
  });
  req.once('aborted', () => {
    if (!requestController.signal.aborted) requestController.abort(Object.assign(new Error('HTTP 客户端已取消请求'), {
      code: 'client_closed', component: 'http', retryable: true,
    }));
  });

  async function runHandler() {
    const t0 = Date.now();
    const logRequest = (status) => {
      const ms = Date.now() - t0;
      if (pathname !== '/health' && pathname !== '/app.js' && pathname !== '/app.css') {
        // 历史账户专用说明已从试用包移除。
        // 错误(4xx/5xx)、写操作(POST/PUT/DELETE)、重定向(3xx) 仍全部记录
        // 需要排查时可设 config.log_quiet_gets=false 恢复全量日志
        const { log_quiet_gets } = require('../lib/config');
        const quietGets = log_quiet_gets !== false;
        const isQuietGet = quietGets && req.method === 'GET' && status >= 200 && status < 300;
        if (!isQuietGet) {
          console.log(`[${new Date().toISOString()}] ${req.method} ${pathname} → ${status} (${ms}ms)`);
        }
      }
    };

    // 全局读接口鉴权（可选，仅当配置了 READ_API_TOKEN 时启用）
    if (!requireReadAuth(req)) {
      logRequest(401);
      return sendJSON(res, { ok: false, error: '需要有效的 API 令牌访问此接口' }, 401);
    }

    // 页面后缀路由：所有 PAGE_ROUTES 都返回 app.html
    // v4 切换：旧页面路径 302 到新前端对应 tab；未映射的老路径回退作战室
    const V4_MAP = { '/zuozhanshi': 'warroom', '/sucai-assets': 'materials', '/reports': 'reports', '/replay': 'replay', '/system': 'system', '/sucai': 'materials', '/zhibo': 'warroom', '/zonglan': 'warroom', '/monitor': 'system', '/jilu': 'system', '/huifang': 'replay', '/diagnose': 'reports' };
    if (PAGE_ROUTES.has(pathname)) {
      const tab = V4_MAP[pathname] || 'warroom';
      res.writeHead(302, { Location: '/v4#/' + tab });
      return res.end();
    }
    // v4 新前端：/v4 入口 + /v4/* 静态资源（拒绝路径遍历）
    // （2026-07-30 审计清理：旧 /pages/*.js 静态分支随旧前端删除而移除）
    if (pathname === '/v4' || pathname === '/v4/') {
      return handleV4Index(req, res);
    }
    if (pathname.startsWith('/v4/') && /\.(js|css|html|png|jpg|jpeg|gif|svg|ico|webp|woff2?)$/.test(pathname) && !pathname.includes('..')) {
      return handleStaticAsset(req, res, url, pathname);
    }
    const preflightMatch = pathname.match(/^\/api\/accounts\/([A-Za-z0-9_-]{2,40})\/preflight$/);
    const handler = preflightMatch
      ? ((request, response) => handleAccountPreflight(request, response, preflightMatch[1]))
      : routes.get(pathname);
    if (handler) {
      // 全局 account 参数格式校验（防止路径遍历和注入）
      const accountParam = url.searchParams.get('account') || url.searchParams.get('accountId');
      if (accountParam && !isValidAccountId(accountParam)) {
        logRequest(400);
        return sendJSON(res, { ok: false, error: `account 参数格式非法: ${accountParam}` }, 400);
      }
      // 历史账户专用说明已从试用包移除。
      // 错误在调用瞬间 400 爆炸，绝不给"看起来正常的错数据"；未注册白名单的路由默认放行（渐进覆盖）
      const knownParams = ROUTE_PARAMS.get(pathname);
      if (knownParams) {
        for (const key of url.searchParams.keys()) {
          if (COMMON_PARAMS.has(key) || knownParams.includes(key)) continue;
          const hint = PARAM_ALIAS[key] ? `，是否想用 ${PARAM_ALIAS[key]}？` : `（本接口支持参数：${knownParams.join(' / ') || '无'}）`;
          logRequest(400);
          return sendJSON(res, { ok: false, error: `未知参数 ${key}${hint}` }, 400);
        }
        // P1 兼容期：双收旧参数名已生效（不拦），响应头标 deprecation 引导改名
        const deprecatedUsed = [...url.searchParams.keys()].filter(k => PARAM_ALIAS[k] && knownParams.includes(k));
        if (deprecatedUsed.length) {
          res.setHeader('X-Deprecated-Params', deprecatedUsed.map(k => `${k}->${PARAM_ALIAS[k]}`).join(', ')); // HTTP头仅ASCII，别用→
        }
      }
      // 包装 handler 以记录响应状态
      const result = await require('../lib/onboardingGuard').runGuardedWrite(req, res, url, handler);
      logRequest(res.statusCode || 200);
      return result;
    }
    logRequest(404);
    return sendJSON(res, { error: 'Not Found' }, 404);
  }

  runHandler().catch(err => {
    console.error(`[Router Error] 未捕获的路由异常 ${req.url}:`, err);
    if (!res.headersSent && !res.writableEnded) {
      require('../lib/handleApiError').handleApiError(res, err);
    } else if (!res.writableEnded) {
      res.end();
    }
  });
}

module.exports = setupRoutes;
