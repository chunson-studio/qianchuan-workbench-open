'use strict';

const fs = require('fs');
const path = require('path');
const {
  CONFIG_PATH,
  ACCOUNT_PROFILES_DIR,
  SCRIPTS_DIR,
  CACHE_DIR,
  STORAGE_DIR,
  REPORTS_DIR,
  LOGS_DIR,
  QIANCHUAN_ACCOUNTS,
  account_config,
  agent_policy,
  applyAccountRegistry,
} = require('./config');
const { isValidAccountId, writeJsonAtomic } = require('./api-helpers');
const { serialiseMutation, readConfig } = require('./accountRegistry');

function deleteError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source && typeof source === 'object' ? source : {});
}

function applyRegistryAllowEmpty(config) {
  const accounts = Array.isArray(config.qianchuan_accounts) ? config.qianchuan_accounts : null;
  if (!accounts) throw deleteError('config_invalid', '账号配置格式无效', 503);
  if (accounts.length) return applyAccountRegistry(config);

  QIANCHUAN_ACCOUNTS.splice(0, QIANCHUAN_ACCOUNTS.length);
  replaceObject(account_config, config.account_config || {});
  replaceObject(agent_policy, config.agent_policy || {});
  return QIANCHUAN_ACCOUNTS;
}

function safeInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function removePath(target, allowedRoot, removed, warnings) {
  if (!target || !safeInside(allowedRoot, target)) return;
  try {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  } catch (error) {
    warnings.push(`${path.basename(target)}: ${error.message}`);
  }
}

function removeNamedRuntimeArtifacts(root, accountId, removed, warnings) {
  if (!root || !fs.existsSync(root)) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    warnings.push(`${path.basename(root)}: ${error.message}`);
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === accountId || name.startsWith(accountId + '.') || name.startsWith(accountId + '-') || name.startsWith(accountId + '_')) {
      removePath(path.join(root, name), root, removed, warnings);
    }
  }
}

function cleanupAccountFiles(accountId, account, configPath = CONFIG_PATH) {
  const removed = [];
  const warnings = [];
  const configRoot = path.dirname(configPath);

  removePath(path.join(ACCOUNT_PROFILES_DIR, `${accountId}.json`), ACCOUNT_PROFILES_DIR, removed, warnings);
  removePath(path.join(configRoot, 'onboarding', `${accountId}.json`), path.join(configRoot, 'onboarding'), removed, warnings);

  const cookieFile = account && typeof account.cookieFile === 'string' ? account.cookieFile : '';
  if (cookieFile) {
    const cookiePath = path.resolve(SCRIPTS_DIR, cookieFile);
    if (safeInside(SCRIPTS_DIR, cookiePath)) removePath(cookiePath, SCRIPTS_DIR, removed, warnings);
    else warnings.push('Cookie 文件路径非法，未删除');
  }

  for (const root of [CACHE_DIR, STORAGE_DIR, REPORTS_DIR, LOGS_DIR]) {
    removeNamedRuntimeArtifacts(root, accountId, removed, warnings);
  }

  return { removed_count: removed.length, removed, warnings };
}

async function deleteAccountPermanently(input, options = {}) {
  const id = String(input && input.id || '').trim();
  if (!isValidAccountId(id)) throw deleteError('invalid_account', '账号 ID 格式非法');
  if (input && input.confirm !== true) throw deleteError('confirmation_required', '请确认后再删除账号');

  return serialiseMutation(async () => {
    const configPath = options.configPath || CONFIG_PATH;
    const config = readConfig(configPath);
    const active = Array.isArray(config.qianchuan_accounts) ? config.qianchuan_accounts : [];
    const archived = Array.isArray(config.archived_qianchuan_accounts) ? config.archived_qianchuan_accounts : [];
    const account = active.find(item => item && item.id === id) || archived.find(item => item && item.id === id);
    if (!account) throw deleteError('account_not_found', `未找到账号 ${id}`, 404);

    if (typeof options.beforeDelete === 'function') await options.beforeDelete(id);

    config.qianchuan_accounts = active.filter(item => item && item.id !== id);
    config.archived_qianchuan_accounts = archived.filter(item => item && item.id !== id);

    if (config.account_config && typeof config.account_config === 'object') {
      const next = { ...config.account_config };
      delete next[id];
      config.account_config = next;
    }
    if (config.archived_account_config && typeof config.archived_account_config === 'object') {
      const next = { ...config.archived_account_config };
      delete next[id];
      config.archived_account_config = next;
    }
    if (config.agent_policy && typeof config.agent_policy === 'object') {
      const nextPolicy = { ...config.agent_policy };
      if (nextPolicy.account_policies && typeof nextPolicy.account_policies === 'object') {
        nextPolicy.account_policies = { ...nextPolicy.account_policies };
        delete nextPolicy.account_policies[id];
      }
      config.agent_policy = nextPolicy;
    }

    try {
      writeJsonAtomic(configPath, config);
      applyRegistryAllowEmpty(config);
    } catch (error) {
      if (error && error.code) throw error;
      throw deleteError('registry_apply_failed', `账号删除后未能刷新当前服务: ${error.message}`, 503);
    }

    const cleanup = cleanupAccountFiles(id, account, configPath);
    return {
      id,
      purged: true,
      deleted: true,
      cleanup,
      mcp_reconnect_required: false,
    };
  });
}

module.exports = { deleteAccountPermanently, cleanupAccountFiles, applyRegistryAllowEmpty };
