'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepare, redact } = require('../tools/run-qc-playwright-cli.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-cli-check-'));
const secretFile = path.join(root, 'secret.json');
const cliFile = path.join(root, 'cli.js');
const cliConfigFile = path.join(root, 'config.json');
const configFile = path.join(root, 'binding.json');
const token = 'fixture_only_0600000037890123456789';
fs.writeFileSync(cliFile, '');
fs.writeFileSync(cliConfigFile, '{}');
fs.writeFileSync(secretFile, JSON.stringify({profile_dir_name:'Profile 103',extension_id:'mmlmfjhmonkocbjadbfplnigmagldckm',extension_token:token}));
fs.writeFileSync(configFile, JSON.stringify({session:'qc-test',profileDirName:'Profile 103',cliFile,cliConfigFile,workDir:root,profileSecretFile:secretFile}));
test('pins profile/session and keeps token out of process arguments', () => {
  const p = prepare(configFile, ['attach'], {PATH:'existing',PLAYWRIGHT_MCP_PROFILE_DIR_NAME:'Profile 102',PLAYWRIGHT_MCP_EXTENSION_TOKEN:'other',PWTEST_EXTENSION_USER_DATA_DIR:'other',NODE_OPTIONS:'--inspect'});
  assert.equal(p.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME, 'Profile 103');
  assert.equal(p.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, token);
  assert.equal(p.env.PWTEST_EXTENSION_USER_DATA_DIR, undefined);
  assert.equal(p.env.NODE_OPTIONS, '--dns-result-order=ipv4first');
  assert.equal(p.env.PATH, 'existing');
  assert.equal(p.argv.some(v => v.includes(token)), false);
  assert.ok(p.argv.includes('-s=qc-test'));
});
test('rejects alternate target and broad destructive CLI commands', () => {
  for (const args of [['attach','--cdp=http://localhost:9222'],['run-code','--session=other'],['list','--config=other'],['close-all'],['kill-all'],['delete-data']]) {
    assert.throws(() => prepare(configFile,args));
  }
});
test('redacts credential value and credential query fields', () => {
  const result = redact('secret='+token+' https://local/?token=other&ok=1',token);
  assert.equal(result.includes(token),false);
  assert.equal(result.includes('token=other'),false);
  assert.ok(result.includes('&ok=1'));
});
test('rejects secret belonging to a different browser profile', () => {
  const otherConfig = path.join(root, 'other.json');
  fs.writeFileSync(otherConfig,JSON.stringify({...JSON.parse(fs.readFileSync(configFile)),profileDirName:'Profile 102'}));
  assert.throws(() => prepare(otherConfig,['attach']),{code:'cli_secret_binding_invalid'});
});
