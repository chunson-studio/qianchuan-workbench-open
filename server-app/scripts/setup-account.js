#!/usr/bin/env node
'use strict';

// CLI 与 HTTP/MCP 使用同一接入服务、问题定义和持久化逻辑。
const fs = require('node:fs');
const readline = require('node:readline/promises');
const service = require('../server/lib/accountOnboarding');
function argsOf(argv) {
  const result = {};
  const allowed = ['account', 'cookie-json', 'advertiser-id', 'candidate', 'answers-json', 'non-interactive', 'save', 'help'];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!allowed.includes(key)) throw new Error('不支持此参数；不再提供覆盖配置的 --force。请使用 --help');
    result[key] = ['non-interactive', 'save', 'help'].includes(key) ? true : argv[++i];
  }
  return result;
}
async function main(argv = process.argv.slice(2)) {
  const args = argsOf(argv);
  if (args.help) { console.log('npm run setup -- [--account 已有账户] [--cookie-json Agent本机同步文件] [--advertiser-id 广告账户ID] [--answers-json 回答文件] [--non-interactive] [--save]\n多个直客账户登录时可指定广告账户ID，系统仍核验归属。默认仅保存草稿；非交互模式 --save 明确确认后才保存账户配置。新用户在本场浏览器登录后由 Codex 核验接续；--cookie-json 仅供 Agent 本机同步，不要求用户导出文件。'); return; }
  const rl = args['non-interactive'] ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async text => rl ? (await rl.question(text + ': ')).trim() : '';
  const select = async (list, label) => {
    list.forEach((item, index) => console.log((index + 1) + '. ' + item.name));
    if (list.length === 1) return list[0];
    if (!rl) throw new Error(label + '不唯一，请在工作台选择后继续');
    const index = Number(await ask(label + '，输入序号')) - 1;
    if (!Number.isInteger(index) || !list[index]) throw new Error('选择无效');
    return list[index];
  };
  try {
    const status = service.getStatus();
    let id = args.account;
    let file = args['cookie-json'];
    if (!id && !file && status.accounts.length) {
      const selection = await select([...status.accounts, { id: null, name: '接入新账户' }], '选择已有账户或新增');
      id = selection.id;
    }
    if (!id && !file) {
      throw Object.assign(new Error('请在本场浏览器登录千川，由 Codex 核验账户身份并完成接续；无需安装扩展、导出文件或粘贴 JSON。'), { statusCode: 400, code: 'browser_login_required' });
    }
    if (file) {
      const discovery = await service.importCredential(fs.readFileSync(file.replace(/^"|"$/g, ''), 'utf8'), args['advertiser-id'] ? { advertiser_id: args['advertiser-id'] } : {});
      const candidate = args.candidate ? discovery.candidates.find(c => c.candidate_id === args.candidate)
        : await select(discovery.candidates, '选择已验证账户');
      if (!candidate) throw new Error('候选账户不存在');
      const connected = await service.selectAccount({ discovery_id: discovery.discovery_id, candidate_id: candidate.candidate_id, ...(id ? { account_id: id } : {}) });
      id = connected.account.id;
    }
    if (!id) throw new Error('请由 Codex 核验浏览器身份并完成账户接入');
    let state = service.getStatus(id);
    if (args['answers-json']) {
      let answers;
      try { answers = JSON.parse(fs.readFileSync(args['answers-json'], 'utf8')); }
      catch { throw new Error('回答文件不是有效 JSON'); }
      state = await service.updateDraft(id, { revision: state.revision, answers });
    }
    if (rl) {
      while (state.next_questions.length) {
        const answers = {};
        for (const q of state.next_questions) {
          if (q.options) console.log(q.options.map((v, i) => (i + 1) + '=' + v).join(' / '));
          const value = await ask(q.label + (q.type === 'actions' ? '（多项序号用逗号分开，留空表示无）' : ''));
          if (q.type === 'actions') answers[q.key] = value ? value.split(',').map(x => q.options[Number(x.trim()) - 1]) : [];
          else if (q.type === 'number') answers[q.key] = value || null;
          else if (q.type === 'select') answers[q.key] = value ? q.options[Number(value) - 1] : q.options.includes('unknown') ? 'unknown' : q.options[0];
          else answers[q.key] = value;
        }
        state = await service.updateDraft(id, { revision: state.revision, answers });
      }
    }
    state = await service.rehearse(id);
    if (state.observations.plans.length && !state.platform_current && rl) {
      const selected = await select(state.observations.plans, '选择主计划');
      state = await service.updateDraft(id, { revision: state.revision, primary_ad_id: selected.id });
      state = await service.rehearse(id);
    }
    console.log(JSON.stringify({ account: state.account, platform_current: state.platform_current, answers: state.answers,
      missing: state.missing, authorization: state.authorization, rehearsal: state.rehearsal }, null, 2));
    const confirmed = args.save || (rl && await ask('确认保存本次账户资料？输入“确认”') === '确认');
    if (confirmed) {
      const saved = await service.save(id, { revision: state.revision, confirm: true });
      console.log('账户接入已保存。' + saved.authorization.explanation);
    } else console.log('草稿已保留；下次运行可继续。未更改账户投放配置。');
  } finally { rl?.close(); }
}
if (require.main === module) main().catch(error => {
  console.error('接入未完成：' + (error.statusCode && error.statusCode < 500 ? error.message : '请检查文件格式与账户连接，或使用工作台继续。不会输出凭据。'));
  process.exitCode = 1;
});
module.exports = { main, argsOf };
