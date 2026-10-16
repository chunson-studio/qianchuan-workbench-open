const fs = require('fs');
const path = require('path');


const PROJECT_DIR = __dirname;
const ROOT_DIR = path.resolve(PROJECT_DIR, '..', '..');
const RUNTIME_DATA_ROOT = process.env.QC_RUNTIME_DATA_ROOT
  ? path.resolve(process.env.QC_RUNTIME_DATA_ROOT)
  : ROOT_DIR;


const CONFIG_ROOT = process.env.QC_RUNTIME_CONFIG_ROOT
  ? path.resolve(process.env.QC_RUNTIME_CONFIG_ROOT)
  : ROOT_DIR;

const SCRIPTS_DIR = path.join(CONFIG_ROOT, 'scripts');
const CACHE_DIR = path.join(RUNTIME_DATA_ROOT, 'cache');
const REPORTS_DIR = path.join(RUNTIME_DATA_ROOT, 'reports');
const LOGS_DIR = path.join(RUNTIME_DATA_ROOT, 'logs');
const TMP_DIR = path.join(RUNTIME_DATA_ROOT, 'tmp');
const STORAGE_DIR = path.join(RUNTIME_DATA_ROOT, 'storage');
const COOKIE_PATH = path.join(SCRIPTS_DIR, 'cookie.txt');


[CACHE_DIR, REPORTS_DIR, LOGS_DIR, TMP_DIR, STORAGE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});


let PORT = 18991;

let AAVID = '';





const QIANCHUAN_ACCOUNTS = [];

const account_config = {};

let PAGE_SIZE = 200;

let REQUEST_INTERVAL = 1500; 
let ACCOUNTS = [];
let SCHEDULER = {
  enabled: true,
  statusIntervalMs: 30 * 1000,
  liveDecisionMs: 60 * 60 * 1000,
  idleDecisionMs: 3 * 60 * 60 * 1000,
  liveFreshMs: 10 * 60 * 1000,
  staleRounds: 2,
};
let WRITE_API_TOKEN = process.env.QC_WRITE_TOKEN || ''; 
let CLEANUP_ENABLED = false; 
let UI_FEATURES = {
};

let HOST = process.env.QC_HOST || '127.0.0.1';
let manual_config = { avg_order_price:null, break_even_roi:null, full_auto_delete:false }; 


let MHS = {};
let CLASSIFICATION = {};

let YUNTU_AADVID = '';
let YUNTU_INDUSTRY_ID = '';
let YUNTU_BRAND_ID = '';
let YUNTU_CDP_PORT = 9333;



let YUNTU_ACCOUNTS = [];

const configPath = path.join(CONFIG_ROOT, 'config.json');
const configExamplePath = path.join(CONFIG_ROOT, 'config.example.json');
const ACCOUNT_PROFILES_DIR = path.join(CONFIG_ROOT, 'account-profiles');
require('./accountPersistence').recoverAtStartup(CONFIG_ROOT);
let config = {};

function normalizeQcAccounts(rawAccounts) {
  return (Array.isArray(rawAccounts) ? rawAccounts : []).map(a => ({
    id: a.id,
    name: a.name,
    aavid: String(a.aavid),
    anchorId: a.anchorId || '',
    primary_ad_id: a.primary_ad_id || '',
    cookieFile: a.cookieFile || 'cookie.txt',
    
    expectedLiveWindow: a.expectedLiveWindow || '',
    compassName: a.compassName || a.name || '',
    compassMatch: a.compassMatch || a.name || ''
  }));
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source && typeof source === 'object' ? source : {});
}


function applyAccountRegistry(nextConfig) {
  const rawAccounts = nextConfig && nextConfig.qianchuan_accounts;
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
    throw new Error('qianchuan_accounts 不能为空');
  }
  const normalized = normalizeQcAccounts(rawAccounts);
  const ids = new Set();
  for (const account of normalized) {
    if (!account.id || ids.has(account.id)) throw new Error(`账号列表存在非法或重复 ID: ${account.id || '(empty)'}`);
    ids.add(account.id);
  }
  QIANCHUAN_ACCOUNTS.splice(0, QIANCHUAN_ACCOUNTS.length, ...normalized);
  replaceObject(account_config, nextConfig.account_config);
  replaceObject(agent_policy, nextConfig.agent_policy);
  return QIANCHUAN_ACCOUNTS;
}

try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.error('[config] 已成功加载本地 config.json 配置');
  } else if (fs.existsSync(configExamplePath)) {
    
    console.error('[config] 首次启动，请在工作台完成账户接入');
  }
} catch (e) {
  console.error('[config] 读取配置失败，将使用无账户默认值；请检查配置格式与文件权限');
}

if (config.port) PORT = config.port;
if (process.env.QC_PORT) {
  const p = parseInt(process.env.QC_PORT, 10);
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) PORT = p;
  else console.error(`[config] 忽略非法 QC_PORT="${process.env.QC_PORT}"，继续使用 ${PORT}`);
}
if (config.aavid) AAVID = String(config.aavid);
if (config.page_size) PAGE_SIZE = config.page_size;
if (config.request_interval) REQUEST_INTERVAL = config.request_interval;

if (Array.isArray(config.qianchuan_accounts) && config.qianchuan_accounts.length) {
  QIANCHUAN_ACCOUNTS.push(...normalizeQcAccounts(config.qianchuan_accounts));
}

if (Array.isArray(config.accounts) && config.accounts.length) {
  ACCOUNTS = config.accounts.filter(a => a && a.id);
}
if (config.scheduler) {
  SCHEDULER = { ...SCHEDULER, ...config.scheduler };
}
if (config.write_api_token) WRITE_API_TOKEN = String(config.write_api_token);
if (typeof config.cleanup_enabled === 'boolean') CLEANUP_ENABLED = config.cleanup_enabled;
if (config.ui_features && typeof config.ui_features === 'object') {
  UI_FEATURES = Object.fromEntries(Object.keys(UI_FEATURES).map(key => [key, config.ui_features[key] ?? UI_FEATURES[key]]));
}

if (config.host && !process.env.QC_HOST) HOST = String(config.host);
if (config.manual_config && typeof config.manual_config === 'object') {
  manual_config = { ...manual_config, ...config.manual_config };
}

if (config.mhs && typeof config.mhs === 'object') {
  MHS = { ...MHS, ...config.mhs };
}

if (config.account_config && typeof config.account_config === 'object') {
  Object.assign(account_config, config.account_config);
}

const agent_policy = config.agent_policy && typeof config.agent_policy === 'object'
  ? { ...config.agent_policy }
  : {};

let seasonal_products = {};
if (config.seasonal_products && typeof config.seasonal_products === 'object') {
  seasonal_products = config.seasonal_products;
}
if (config.classification && typeof config.classification === 'object') {
  CLASSIFICATION = { ...CLASSIFICATION, ...config.classification };
}
if (config.yuntu_aavid) YUNTU_AADVID = String(config.yuntu_aavid);
if (config.yuntu_industry_id) YUNTU_INDUSTRY_ID = String(config.yuntu_industry_id);
if (config.yuntu_brand_id) YUNTU_BRAND_ID = String(config.yuntu_brand_id);
if (config.yuntu_cdp_port) YUNTU_CDP_PORT = parseInt(config.yuntu_cdp_port, 10) || YUNTU_CDP_PORT;

if (Array.isArray(config.yuntu_accounts) && config.yuntu_accounts.length) {
  YUNTU_ACCOUNTS = config.yuntu_accounts.map(a => ({
    id: a.id, name: a.name, aadvid: String(a.aadvid), brand_id: String(a.brand_id),
    industry_id: String(a.industry_id), cookieFile: a.cookieFile || 'yuntu_cookie.txt',
    version: a.version || 'brand',
  }));
}


const MAX_PAGES = 25;

const GFVERSION = '1.0.0.5718';

const CACHE_TTL_MS = 30 * 1000;
const SLOW_REQUEST_MS = 8000;
const SLOW_REQUEST_LIMIT = 3;

module.exports = {
  ROOT_DIR,
  RUNTIME_DATA_ROOT,
  PROJECT_DIR: ROOT_DIR,
  SCRIPTS_DIR,
  CACHE_DIR,
  STORAGE_DIR,
  REPORTS_DIR,
  LOGS_DIR,
  COOKIE_PATH,
  PORT,
  HOST,
  AAVID,
  PAGE_SIZE,
  REQUEST_INTERVAL,
  MAX_PAGES,
  GFVERSION,
  CACHE_TTL_MS,
  SLOW_REQUEST_MS,
  SLOW_REQUEST_LIMIT,
  ACCOUNTS,
  SCHEDULER,
  WRITE_API_TOKEN,
  CLEANUP_ENABLED,
  UI_FEATURES,
  manual_config,
  MHS,
  account_config,
  agent_policy,
  seasonal_products,
  CLASSIFICATION,
  YUNTU_AADVID,
  YUNTU_INDUSTRY_ID,
  YUNTU_BRAND_ID,
  YUNTU_CDP_PORT,
  YUNTU_ACCOUNTS,
  QIANCHUAN_ACCOUNTS,
  CONFIG_PATH: configPath,
  ACCOUNT_PROFILES_DIR,
  applyAccountRegistry,
};
