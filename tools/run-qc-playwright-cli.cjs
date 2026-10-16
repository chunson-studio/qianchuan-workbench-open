'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const commands = new Set(['attach','detach','list','tab-list','tab-new','tab-select','tab-close','snapshot','screenshot','run-code','eval','reload','click']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function prepare(configFile, args, baseEnv = process.env) {
  if (!path.isAbsolute(configFile || '') || !Array.isArray(args) || !commands.has(args[0])) fail('cli_input_invalid');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  for (const key of ['cliFile','workDir','cliConfigFile']) {
    if (!path.isAbsolute(config[key] || '') || !fs.existsSync(config[key])) fail('cli_path_invalid');
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(config.session || '') || !/^(Default|Profile \d+)$/.test(config.profileDirName || '')) fail('cli_binding_invalid');
  if (args.slice(1).some(v => typeof v !== 'string' || /^(-s(?:=|$)|--(?:session|config|cdp|endpoint|extension|profile|browser|help|version)(?:=|$))/.test(v))) fail('cli_binding_override_rejected');
  let token = '';
  if (config.profileSecretFile) {
    if (!path.isAbsolute(config.profileSecretFile)) fail('cli_secret_path_invalid');
    const secret = JSON.parse(fs.readFileSync(config.profileSecretFile, 'utf8'));
    if (secret.profile_dir_name !== config.profileDirName || secret.extension_id !== 'mmlmfjhmonkocbjadbfplnigmagldckm' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret.extension_token || '')) fail('cli_secret_binding_invalid');
    token = secret.extension_token;
  }
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !/^PLAYWRIGHT_|^PWTEST_|^NODE_OPTIONS$/i.test(key)));
  env.NODE_OPTIONS = '--dns-result-order=ipv4first';
  env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = config.profileDirName;
  if (token) env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
  const commandArgs = args[0] === 'attach' ? ['attach','--extension=chrome',`--config=${config.cliConfigFile}`] : args;
  if (args[0] === 'attach' && args.length !== 1) fail('cli_attach_arguments_invalid');
  return { config, token, env, argv: [config.cliFile, `-s=${config.session}`, ...commandArgs] };
}
function redact(text, token = '') {
  let result = String(text);
  if (token) result = result.replaceAll(token, '[redacted]');
  return result.replace(/([?&](?:token|msToken|a_bogus|verifyFp)=)[^&\s"<>]+/gi, '$1[redacted]');
}
async function run(configFile, args) {
  const { config, token, env, argv } = prepare(configFile, args);
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: config.workDir, env, windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', () => reject(new Error('cli_spawn_failed')));
    child.on('close', (code, signal) => resolve({ session: config.session, command: args[0], exit_code: code, signal, elapsed_ms: Date.now()-start, stdout: redact(stdout, token), stderr: redact(stderr, token) }));
  });
}
module.exports = { prepare, redact, run };
if (require.main === module) {
  run(process.argv[2], process.argv.slice(3)).then(result => {
    process.stdout.write(JSON.stringify(result)+'\n');
    process.exitCode = result.exit_code === 0 ? 0 : 1;
  }).catch(error => { process.stderr.write((error.code || 'cli_failed')+'\n'); process.exitCode = 1; });
}
