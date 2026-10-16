'use strict';
const path = require('node:path');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');
const { sendJSON } = require('../lib/utils');
const { createSnapshotReader } = require('../lib/workbenchSnapshot');
const project = path.resolve(__dirname, '../../..');
const roots = process.env.QC_CONTROL_RUNTIME_ROOTS
  ? process.env.QC_CONTROL_RUNTIME_ROOTS.split(path.delimiter).filter(Boolean)
  : [path.join(project, 'private-runtime'), path.join(project, 'work/browser-actions')];
const read = createSnapshotReader({ roots });
module.exports = function handleWorkbenchSnapshot(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, code: 'method_not_allowed' }, 405);
  const account = url.searchParams.get('account');
  if (account && !QIANCHUAN_ACCOUNTS.some(a => a.id === account)) return sendJSON(res, { ok: false, code: 'unknown_account' }, 400);
  res.setHeader('Cache-Control', 'no-store');
  return sendJSON(res, { ok: true, ...read(account ? QIANCHUAN_ACCOUNTS.filter(a => a.id === account) : QIANCHUAN_ACCOUNTS) });
};
