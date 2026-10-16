'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { attachQianchuanChrome, getChromePageTarget, readQianchuanControlRaw } = require('../src/index.cjs');

async function main() {
  const configFile = process.argv[2], outputFile = process.argv[3];
  if (!configFile || !outputFile) throw Error('usage: npm run read -- <binding.local.json> <output/pool.json>');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/,''));
  if (!path.isAbsolute(config.markerPath || '') || typeof config.target_id !== 'string' || !config.target_id ||
      typeof config.browser_context_id !== 'string' || !config.browser_context_id ||
      !/^\d+$/.test(config.spec?.advertiser_id || '') || !/^\d+$/.test(config.spec?.primary_ad_id || '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(config.spec?.date || '') || !['调控中','手动暂停'].includes(config.spec?.pool)) throw Error('binding_incomplete');
  if (fs.existsSync(outputFile)) throw Error('output_exists_choose_a_new_path');
  const attached = await attachQianchuanChrome({markerPath:config.markerPath,expectedPort:config.expectedPort ?? undefined});
  try {
    const candidates = [];
    for (const context of attached.browser.contexts()) for (const page of context.pages()) {
      const url = new URL(page.url());
      if (url.origin !== 'https://qianchuan.jinritemai.com' || url.searchParams.get('aavid') !== config.spec.advertiser_id || url.searchParams.get('adId') !== config.spec.primary_ad_id) continue;
      const target = await getChromePageTarget(page);
      if (target.targetId === config.target_id && target.browserContextId === config.browser_context_id) candidates.push(page);
    }
    if (candidates.length !== 1) throw Error('exact_page_not_found');
    const page = candidates[0];
    const account = page.getByText('ID：'+config.spec.advertiser_id,{exact:true}).filter({visible:true});
    if (await account.count() !== 1) throw Error('visible_account_mismatch');
    const result = await readQianchuanControlRaw(page,config.spec);
    fs.mkdirSync(path.dirname(path.resolve(outputFile)),{recursive:true});
    fs.writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    process.stdout.write(JSON.stringify({ok:true,total:result.total,visible_rows:result.visible_rows,complete:result.complete,advertising_writes:0})+'\n');
  } finally { await attached.detach(); }
}
main().catch(error => { process.stderr.write((error.code || error.message || 'read_failed')+'\n'); process.exitCode=1; });
