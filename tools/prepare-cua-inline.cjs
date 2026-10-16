'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function prepare({entry, output}) {
  const allowed = ['codex-qc-boost-replay.cua.js', 'codex-qc-control-pools.cua.js', 'material-cost-control-form.cua.mjs', 'check-qc-extension-parallel.cua.cjs'];
  if (!allowed.includes(entry)) throw Error('Unsupported CUA entry');
  const source = entry === 'material-cost-control-form.cua.mjs'
    ? path.join(__dirname, './browser-actions', entry) : path.join(__dirname, entry);
  let code = fs.readFileSync(source, 'utf8');
  if (entry === 'material-cost-control-form.cua.mjs') {
    const age = fs.readFileSync(path.join(path.dirname(source), 'material-age-targeting.cua.mjs'), 'utf8');
    const imported = "import { setMaterialAgeBands } from './material-age-targeting.cua.mjs';";
    if (!code.includes(imported)) throw Error('material_bundle_import_changed');
    const combined = age + '\n' + code.replace(imported, '');
    const names = [...combined.matchAll(/export async function (\w+)\(/g)].map(m => m[1]);
    const body = combined.replace(/export async function /g, 'async function ');
    if (/^\s*(import|export)\s/m.test(body)) throw Error('unsupported_material_bundle_syntax');
    code = 'globalThis.qcMaterialCost = (() => {\n' + body + '\nreturn {' + names.join(',') + '};\n})();\n';
  }
  const sha256 = crypto.createHash('sha256').update(code).digest('hex');
  const payload = {code, title:'初始化千川独立页面脚本', timeout_ms:60000};
  fs.writeFileSync(output, JSON.stringify(payload, null, 2)+'\n');
  return {source, output, sha256, bytes:Buffer.byteLength(code)};
}
module.exports = {prepare};
if (require.main === module) {
  const args=process.argv.slice(2);
  console.log(JSON.stringify(prepare({entry:args[0],output:path.resolve(args[1])})));
}
