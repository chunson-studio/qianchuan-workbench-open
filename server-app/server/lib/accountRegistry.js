'use strict';

// 账号元数据写入口；仅确认接入时保存对应 Cookie，不改历史数据和缓存。
const fs = require('fs');
const path = require('path');
const { isValidAccountId, writeJsonAtomic } = require('./api-helpers');
const { CONFIG_PATH, ACCOUNT_PROFILES_DIR, SCRIPTS_DIR, applyAccountRegistry } = require('./config');
const { consumeCandidate } = require('./accountDiscovery');
const { buildDefaultProfile, normalizeAccountProfile } = require('./accountProfile');
const { contentVersion, commitAccountFiles } = require('./accountPersistence');
const CONFIG_VERSION = Symbol('configurationVersion');
const getConfigVersion = config => config[CONFIG_VERSION];

let mutationTail = Promise.resolve();

function registryError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function serialiseMutation(work) {
  const run = mutationTail.then(work, work);
  mutationTail = run.catch(() => {});
  return run;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return Object.defineProperty({ qianchuan_accounts: [], account_config: {}, agent_policy: {}, scheduler: { enabled: false }, cleanup_enabled: false }, CONFIG_VERSION, { value: null });
    throw registryError('config_unavailable', '无法读取账号配置，请检查文件权限', 503);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象');
    }
    return Object.defineProperty(parsed, CONFIG_VERSION, { value: contentVersion(raw) });
  } catch (error) {
    throw registryError('config_invalid', '账号配置 JSON 无法解析，原文件未更改', 503);
  }
}

function normaliseDiscoveredAccount(candidate, cookie) {
  const aavid = String(candidate && candidate.aavid || '').trim();
  const name = String(candidate && candidate.name || '').trim();
  const anchorId = String(candidate && candidate.anchor_id || '').trim();
  if (!/^\d{5,30}$/.test(aavid) || !name) throw registryError('candidate_invalid', '发现结果缺少可确认的账户身份，未保存 Cookie', 502);
  if (Buffer.byteLength(String(cookie || ''), 'utf8') > 256 * 1024) throw registryError('cookie_too_large', 'Cookie 不能超过 256KB');
  return {
    // AAVID 由账户发现接口给出，是稳定的本地 ID 种子，不接受人工输入。
    id: `account_${aavid}`,
    name: name.slice(0, 80),
    aavid,
    anchorId: /^\d{5,30}$/.test(anchorId) ? anchorId : '',
    cookie: String(cookie || '').trim(),
  };
}

function buildProfile(account) {
  return buildDefaultProfile(account);
}

function newAccountPolicy() {
  return {};
}

function ensurePolicyForNewAccount(config, accountId) {
  const base = config.agent_policy && typeof config.agent_policy === 'object'
    ? clone(config.agent_policy)
    : {};
  const policies = base.account_policies && typeof base.account_policies === 'object'
    ? { ...base.account_policies }
    : {};
  policies[accountId] = newAccountPolicy();
  config.agent_policy = { ...base, account_policies: policies };
}

function publicAccountFromRaw(account, ownConfig) {
  const breakEven = Number(ownConfig && ownConfig.break_even_roi);
  return {
    id: String(account.id),
    name: String(account.name || account.id),
    aavid: String(account.aavid || ''),
    break_even_roi: Number.isFinite(breakEven) && breakEven > 0 ? breakEven : null,
  };
}

function getOptions(options) {
  return {
    configPath: options && options.configPath || CONFIG_PATH,
    profileDir: options && options.profileDir || ACCOUNT_PROFILES_DIR,
    scriptsDir: options && options.scriptsDir || SCRIPTS_DIR,
    applyRegistry: options && options.applyRegistry || applyAccountRegistry,
    consumeCandidate: options && options.consumeCandidate || consumeCandidate,
    beforeArchive: options && options.beforeArchive,
  };
}

function assertCanApply(config, applyRegistry) {
  // applyAccountRegistry 原地刷新进程内引用。它只接受完整、非空且无重复的列表。
  applyRegistry(config);
}

async function persistDiscoveredFields(accountId, fields, options) {
  const opts = getOptions(options);
  return serialiseMutation(async () => {
    const config = readConfig(opts.configPath);
    const active = Array.isArray(config.qianchuan_accounts) ? config.qianchuan_accounts : [];
    const target = active.find(item => item && item.id === accountId);
    if (!target) throw registryError('account_not_found', `账号 ${accountId} 不在可用列表中`, 404);
    const nextFields = {};
    if (/^\d{5,30}$/.test(String(fields && fields.anchorId || ''))) nextFields.anchorId = String(fields.anchorId);
    if (/^\d{5,30}$/.test(String(fields && fields.primaryAdId || ''))) nextFields.primary_ad_id = String(fields.primaryAdId);
    if (!Object.keys(nextFields).length) return { changed: false };
    const profilePath = path.join(opts.profileDir, `${accountId}.json`);
    const previousProfile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : null;
    let nextProfile = null;
    if (previousProfile) {
      const profile = normalizeAccountProfile(JSON.parse(previousProfile), {
        id: target.id,
        name: target.name,
        aavid: target.aavid,
        anchorId: target.anchorId,
        primaryAdId: target.primary_ad_id,
      });
      profile.account = { ...(profile.account || {}), ...(nextFields.anchorId ? { anchor_id: nextFields.anchorId } : {}), ...(nextFields.primary_ad_id ? { primary_ad_id: nextFields.primary_ad_id } : {}) };
      nextProfile = profile;
    }
    const nextConfig = clone(config);
    nextConfig.qianchuan_accounts = active.map(item => item && item.id === accountId ? { ...item, ...nextFields } : item);
    try {
      const files = [];
      if (nextProfile) files.push({ file: profilePath, text: JSON.stringify(nextProfile, null, 2), expectedVersion: contentVersion(previousProfile) });
      files.push({ file: opts.configPath, text: JSON.stringify(nextConfig, null, 2), expectedVersion: getConfigVersion(config) });
      commitAccountFiles(path.dirname(opts.configPath), files, () => assertCanApply(nextConfig, opts.applyRegistry));
    } catch (error) {
      if (error && error.code) throw error;
      throw registryError('preflight_persist_failed', '无法保存预检发现的账户信息，原文件已恢复', 503);
    }
    return { changed: true, ...nextFields };
  });
}

// 能力矩阵属于账号 Profile，而非进程全局配置；仅由只读预检写入。
async function persistPreflight(accountId, result, options) {
  const opts = getOptions(options);
  return serialiseMutation(async () => {
    const config = readConfig(opts.configPath);
    const account = (config.qianchuan_accounts || []).find(item => item && item.id === accountId);
    if (!account) throw registryError('account_not_found', `账号 ${accountId} 不在可用列表中`, 404);
    fs.mkdirSync(opts.profileDir, { recursive: true });
    const profilePath = path.join(opts.profileDir, `${accountId}.json`);
    let profile = buildProfile({
      id: account.id, name: account.name, aavid: account.aavid,
      anchorId: account.anchorId, primaryAdId: account.primary_ad_id,
    });
    if (fs.existsSync(profilePath)) {
      try {
        profile = normalizeAccountProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')), {
          id: account.id,
          name: account.name,
          aavid: account.aavid,
          anchorId: account.anchorId,
          primaryAdId: account.primary_ad_id,
        });
      }
      catch (error) { throw registryError('profile_invalid', `账号 Profile 无法解析: ${error.message}`, 503); }
    }
    profile.preflight = {
      checked_at: result.checked_at || new Date().toISOString(),
      capabilities: clone(result.capabilities || {}),
      discovered: clone(result.discovered || {}),
    };
    writeJsonAtomic(profilePath, profile);
    return { persisted: true, checked_at: profile.preflight.checked_at };
  });
}

async function createAccount(input, options) {
  const opts = getOptions(options);
  const discovered = opts.consumeCandidate(input && input.discovery_id, input && input.candidate_id, true);
  const found = normaliseDiscoveredAccount(discovered.candidate, discovered.cookie);
  return serialiseMutation(async () => {
    const config = readConfig(opts.configPath);
    const active = Array.isArray(config.qianchuan_accounts) ? config.qianchuan_accounts : [];
    const existing = active.find(item => String(item.aavid) === found.aavid);
    if (options?.targetAccountId && existing?.id !== options.targetAccountId) {
      throw registryError('account_identity_mismatch', 'Cookie 对应账户与正在更新的账户不符，未更改配置', 409);
    }
    if (existing && !options?.upsert) throw registryError('account_exists', '该账户已存在，请使用继续配置或更新凭据', 409);
    const archived = config.archived_qianchuan_accounts || [];
    if (archived.some(item => String(item.aavid) === found.aavid)) throw registryError('account_archived', '该账户已移出，请先恢复账户', 409);
    const account = { ...found, id: existing?.id || found.id };
    const profilePath = path.join(opts.profileDir, account.id + '.json');
    if (!existing && fs.existsSync(profilePath)) throw registryError('account_profile_exists', '存在历史 Profile，不能覆盖，请先恢复账户', 409);
    const rawAccount = {
      ...(existing || {}), id: account.id, name: existing?.name || account.name, aavid: account.aavid,
      anchorId: existing?.anchorId || account.anchorId, primary_ad_id: existing?.primary_ad_id || '',
      cookieFile: 'qianchuan_cookie_' + account.id + '.txt',
      expectedLiveWindow: existing?.expectedLiveWindow || '',
      compassName: existing?.compassName || account.name, compassMatch: existing?.compassMatch || account.name,
    };
    config.qianchuan_accounts = existing ? active.map(item => item.id === account.id ? rawAccount : item) : [...active, rawAccount];
    config.account_config = { ...(config.account_config || {}) };
    if (!existing) ensurePolicyForNewAccount(config, account.id);
    const profileText = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : null;
    const profile = profileText !== null
      ? normalizeAccountProfile(JSON.parse(profileText), rawAccount)
      : buildProfile(rawAccount);
    profile.connection = { identity_verified: true, verified_at: new Date().toISOString(), source: 'qianchuan_account_user_info' };
    if (!existing) profile.onboarding = { version: 1, state: 'connected', managed: true };
    const cookiePath = path.resolve(opts.scriptsDir, rawAccount.cookieFile);
    if (!cookiePath.startsWith(path.resolve(opts.scriptsDir) + path.sep)) throw registryError('cookie_path_invalid', 'Cookie 路径非法', 500);
    const { commitAccountFiles } = require('./accountPersistence');
    commitAccountFiles(path.dirname(opts.configPath), [
      { file: profilePath, text: JSON.stringify(profile, null, 2) + '\n', expectedVersion: contentVersion(profileText) },
      { file: cookiePath, text: account.cookie + '\n' },
      { file: opts.configPath, text: JSON.stringify(config, null, 2) + '\n', expectedVersion: getConfigVersion(config) },
    ], () => assertCanApply(config, opts.applyRegistry));
    opts.consumeCandidate(input.discovery_id, input.candidate_id);
    return { account: publicAccountFromRaw(rawAccount, config.account_config[account.id]), profile_created: !existing,
      cookie_imported: true, updated: !!existing, mcp_reconnect_required: false };
  });
}

function isConfirmed(confirmValue, id, action) {
  if (confirmValue === true) return true;
  const s = String(confirmValue || '').trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (['true', 'yes', '1', 'confirm', '确认', '删除', '移出', '恢复', 'purge', 'delete'].includes(lower)) return true;
  if (s === id || lower === `remove ${id}`.toLowerCase() || lower === `restore ${id}`.toLowerCase()) return true;
  if (s === `移出账号 ${id}` || s === `恢复账号 ${id}` || s === `删除账号 ${id}`) return true;
  return false;
}

function confirmedId(value, action) {
  const id = String(value || '').trim();
  if (!isValidAccountId(id)) throw registryError('invalid_account', '账号 ID 格式非法');
  const phrases = action === 'archive'
    ? { expected: `移出账号 ${id}`, legacy: `REMOVE ${id}` }
    : { expected: `恢复账号 ${id}`, legacy: `RESTORE ${id}` };
  return { id, ...phrases };
}

async function archiveAccount(input, options) {
  const { id, expected, legacy } = confirmedId(input && input.id, 'archive');
  if (!isConfirmed(input && input.confirm, id, 'archive')) {
    throw registryError('confirmation_required', `请确认后再移出账号`);
  }
  const opts = getOptions(options);
  return serialiseMutation(async () => {
    const config = readConfig(opts.configPath);
    const active = Array.isArray(config.qianchuan_accounts) ? config.qianchuan_accounts : [];
    const account = active.find(item => item && item.id === id);
    if (!account) throw registryError('account_not_found', `账号 ${id} 不在可用列表中`, 404);
    if (active.length <= 1) throw registryError('last_account', '不能移出最后一个账号；至少保留一个可用账号', 409);

    const archived = Array.isArray(config.archived_qianchuan_accounts) ? config.archived_qianchuan_accounts.filter(item => item && item.id !== id) : [];
    const ownConfig = config.account_config && config.account_config[id];
    if (typeof opts.beforeArchive === 'function') await opts.beforeArchive(id);
    config.qianchuan_accounts = active.filter(item => item && item.id !== id);
    config.archived_qianchuan_accounts = [...archived, { ...clone(account), archived_at: new Date().toISOString() }];
    if (config.account_config && typeof config.account_config === 'object') {
      const next = { ...config.account_config };
      delete next[id];
      config.account_config = next;
    }
    const archivedConfig = config.archived_account_config && typeof config.archived_account_config === 'object'
      ? { ...config.archived_account_config }
      : {};
    if (ownConfig && typeof ownConfig === 'object') archivedConfig[id] = clone(ownConfig);
    config.archived_account_config = archivedConfig;

    try {
      writeJsonAtomic(opts.configPath, config);
      assertCanApply(config, opts.applyRegistry);
    } catch (error) {
      if (error && error.code) throw error;
      throw registryError('registry_apply_failed', `账号已移出配置但未能应用到当前服务: ${error.message}`, 503);
    }
    return { id, archived: true, history_preserved: true, cookie_preserved: true, mcp_reconnect_required: false };
  });
}

async function purgeAccount(input, options) {
  const id = String(input && input.id || '').trim();
  if (!isValidAccountId(id)) throw registryError('invalid_account', '账号 ID 格式非法');
  if (!isConfirmed(input && input.confirm, id, 'purge')) {
    throw registryError('confirmation_required', `请确认后再彻底删除账号`);
  }
  const opts = getOptions(options);
  return serialiseMutation(async () => {
    const config = readConfig(opts.configPath);
    const active = Array.isArray(config.qianchuan_accounts) ? config.qianchuan_accounts : [];
    if (active.some(item => item && item.id === id) && active.length <= 1) {
      throw registryError('last_account', '不能删除最后一个可用账号；至少保留一个可用账号', 409);
    }
    if (typeof opts.beforePurge === 'function') await opts.beforePurge(id);
    const archived = Array.isArray(config.archived_qianchuan_accounts) ? config.archived_qianchuan_accounts : [];
    config.qianchuan_accounts = active.filter(item => item && item.id !== id);
    config.archived_qianchuan_accounts = archived.filter(item => item && item.id !== id);
    if (config.account_config && typeof config.account_config === 'object') {
      const next = { ...config.account_config };
      delete next[id];
      config.account_config = next;
    }
    if (config.archived_account_config && typeof config.archived_account_config === 'object') {
      const nextArchived = { ...config.archived_account_config };
      delete nextArchived[id];
      config.archived_account_config = nextArchived;
    }
    try {
      writeJsonAtomic(opts.configPath, config);
      assertCanApply(config, opts.applyRegistry);
    } catch (error) {
      if (error && error.code) throw error;
      throw registryError('registry_apply_failed', `账号已删除但未能应用到当前服务: ${error.message}`, 503);
    }
    return { id, purged: true, mcp_reconnect_required: false };
  });
}

async function restoreAccount(input, options) {
  const { id, expected, legacy } = confirmedId(input && input.id, 'restore');
  if (!isConfirmed(input && input.confirm, id, 'restore')) {
    throw registryError('confirmation_required', `请确认后再恢复账号`);
  }
  const opts = getOptions(options);
  return serialiseMutation(async () => {
    const config = readConfig(opts.configPath);
    const active = Array.isArray(config.qianchuan_accounts) ? config.qianchuan_accounts : [];
    if (active.some(item => item && item.id === id)) {
      throw registryError('account_exists', `账号 ${id} 已在可用列表中`, 409);
    }
    const archived = Array.isArray(config.archived_qianchuan_accounts) ? config.archived_qianchuan_accounts : [];
    const archivedAccount = archived.find(item => item && item.id === id);
    if (!archivedAccount) throw registryError('archived_account_not_found', `未找到已移出的账号 ${id}`, 404);
    const { archived_at, ...restoredAccount } = clone(archivedAccount);
    config.qianchuan_accounts = [...active, restoredAccount];
    config.archived_qianchuan_accounts = archived.filter(item => item && item.id !== id);
    const archivedConfig = config.archived_account_config && typeof config.archived_account_config === 'object'
      ? config.archived_account_config
      : {};
    config.account_config = { ...(config.account_config || {}), ...(archivedConfig[id] ? { [id]: clone(archivedConfig[id]) } : {}) };
    const nextArchivedConfig = { ...archivedConfig };
    delete nextArchivedConfig[id];
    config.archived_account_config = nextArchivedConfig;

    try {
      writeJsonAtomic(opts.configPath, config);
      assertCanApply(config, opts.applyRegistry);
    } catch (error) {
      if (error && error.code) throw error;
      throw registryError('registry_apply_failed', `账号已恢复到配置但未能应用到当前服务: ${error.message}`, 503);
    }
    return {
      account: publicAccountFromRaw(restoredAccount, config.account_config[id]),
      restored: true,
      history_preserved: true,
      cookie_preserved: true,
      mcp_reconnect_required: false,
    };
  });
}

function listArchivedAccounts(options) {
  const opts = getOptions(options);
  let config;
  try { config = readConfig(opts.configPath); }
  catch (error) {
    // 服务尚未生成本地 config.json 时，运行时示例账号仍可正常展示；没有归档列表即可。
    if (error && error.code === 'config_unavailable') return [];
    throw error;
  }
  const archivedConfig = config.archived_account_config && typeof config.archived_account_config === 'object'
    ? config.archived_account_config
    : {};
  return (Array.isArray(config.archived_qianchuan_accounts) ? config.archived_qianchuan_accounts : []).map(account => ({
    ...publicAccountFromRaw(account, archivedConfig[account.id]),
    archived_at: account.archived_at || null,
  }));
}

module.exports = {
  serialiseMutation,
  readConfig,
  getConfigVersion,
  archiveAccount,
  buildProfile,
  createAccount,
  listArchivedAccounts,
  normaliseDiscoveredAccount,
  persistPreflight,
  persistDiscoveredFields,
  restoreAccount,
  purgeAccount,
};
