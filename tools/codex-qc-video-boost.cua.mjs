// Codex CUA only. Video navigation wraps the shared, verified boost form.
import { loadQianchuanBoostReplay } from './codex-qc-boost-workflow.mjs';

export async function createVideoBoost(tab, cfg) {
  if (!cfg.run_root || typeof cfg.on_checkpoint !== 'function') throw new Error('Explicit evidence directory and checkpoint required');
  const u = new URL(await tab.url());
  if (u.searchParams.get('aavid') !== String(cfg.advertiser_id) || u.searchParams.get('adId') !== String(cfg.primary_ad_id)) throw new Error('Binding mismatch');
  const materialId = String(cfg.material_id);
  await tab.playwright.getByRole('tab', { name: '素材', exact: true }).click();
  await tab.getAXState({ emit: false });
  await tab.playwright.locator('div.main-vmok-plugin-radio-item').filter({ hasText: /^视频$/ }).filter({ visible: true }).click();
  await tab.getAXState({ emit: false });
  const row = tab.playwright.getByRole('row').filter({ hasText: materialId });
  await row.waitFor({ state: 'visible', timeoutMs: 5000 });
  const before = await row.innerText();
  if (!before.includes('素材ID: ' + materialId) || !before.includes('审核通过')) throw new Error('Exact approved video not verified');
  await cfg.on_checkpoint({ channel: 'codex-cua', id: 'video.entry', status: 'read_verified', material_id: materialId, observed_at: new Date().toISOString(), before });
  const replay = await loadQianchuanBoostReplay({ run_root: cfg.run_root });
  const readback = async ({ task_names }) => {
    await tab.playwright.getByRole('tab', { name: '调控', exact: true }).click();
    const filter = tab.playwright.getByRole('textbox', { name: '请选择', exact: true }).nth(2);
    await filter.waitFor({ state: 'visible', timeoutMs: 5000 });
    if (await filter.evaluate(e => e.value) !== '调控中') {
      await filter.click();
      await tab.getAXState({ emit: false });
      await tab.playwright.getByText('调控中', { exact: true }).filter({ visible: true }).last().click();
      await tab.getAXState({ emit: false });
    }
    await tab.playwright.getByRole('row').filter({ hasText: task_names.at(-1) }).waitFor({ state: 'visible', timeoutMs: 5000 });
    const rows = await tab.playwright.getByRole('row').filter({ hasText: 'ID:' }).evaluateAll(es => es.map(e => Array.from(e.querySelectorAll('td')).map(c => c.innerText)));
    const complete = task_names.every(name => rows.filter(c => c[1]?.split('\n')[0] === name && c[2]?.includes(materialId)).length === 1);
    await cfg.on_checkpoint({ channel: 'codex-cua', id: 'video.readback', status: complete ? 'read_verified' : 'attempt_failed', observed_at: new Date().toISOString(), rows, dom: await tab.playwright.domSnapshot() });
    return { complete, rows };
  };
  return replay.replayQianchuanBoostCreate(tab, { ...cfg, refresh: false, defer_readback: true, readback_batch: readback });
}
