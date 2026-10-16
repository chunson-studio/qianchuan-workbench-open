'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { sendJSON } = require('../lib/utils');

const STARTED_AT = new Date().toISOString();
const APP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');

function runtimeFiles() {
  const roots = [
    path.join(APP_ROOT, 'server.js'),
    path.join(APP_ROOT, 'package.json'),
    path.join(APP_ROOT, 'server'),
    path.join(APP_ROOT, 'scripts', 'evaluate_decisions.js'),
    path.join(APP_ROOT, 'scripts', 'extract_lessons.js'),
    path.join(APP_ROOT, 'scripts', 'notify_agent_on_live.js'),
  ];
  const files = [];
  const visit = target => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        visit(path.join(target, entry.name));
      }
      return;
    }
    const relative = path.relative(APP_ROOT, target).replace(/\\/g, '/');
    if (/\.test\.js$/i.test(relative)) return;
    if (!/\.(?:js|json|html|css|svg|webmanifest)$/i.test(relative)) return;
    files.push({ target, relative });
  };
  roots.forEach(visit);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function buildCodeFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of runtimeFiles()) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file.target));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

let COMMIT = null;
try {
  COMMIT = execSync('git rev-parse --short HEAD', {
    cwd: REPO_ROOT,
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim() || null;
} catch { /* 非 git 环境只使用代码指纹 */ }

let CODE_FINGERPRINT;
try { CODE_FINGERPRINT = buildCodeFingerprint(); }
catch { CODE_FINGERPRINT = crypto.createHash('sha256').update(STARTED_AT).digest('hex').slice(0, 16); }

const VERSION = `${COMMIT || 'boot'}-${CODE_FINGERPRINT}`;

function handleVersion(req, res) {
  return sendJSON(res, {
    ok: true,
    v: VERSION,
    commit: COMMIT,
    code_fingerprint: CODE_FINGERPRINT,
    started_at: STARTED_AT,
  });
}

module.exports = handleVersion;
module.exports._test = { runtimeFiles, buildCodeFingerprint, VERSION, COMMIT, CODE_FINGERPRINT, STARTED_AT };
