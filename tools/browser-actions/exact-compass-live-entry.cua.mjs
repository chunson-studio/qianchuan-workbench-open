

export async function openExactCompassLiveBoard({ overview, browser, liveName, startText, save }) {
  if (!liveName || !startText) throw new Error('Live name and current start time required');
  const before = await browser.tabs.list();
  const row = overview.playwright.getByRole('row').filter({ hasText: liveName });
  if (await row.count() !== 1) throw new Error('Current live row is not unique');
  const text = await row.innerText();
  if (!text.includes(startText)) throw new Error('Live start time mismatch');
  if (await row.getByText(liveName, { exact: true }).count() !== 1)
    throw new Error('Exact live name mismatch');
  await row.getByText('大屏', { exact: true }).click();
  const added = (await browser.tabs.list()).filter(t => !before.some(b => b.id === t.id));
  if (added.length !== 1 || !added[0].url?.includes('/screen/live/shop?'))
    throw new Error('Board tab not uniquely observed; inspect original tabs, do not repeat click');
  const board = await browser.tabs.get(added[0].id);
  const dom = await board.playwright.domSnapshot();
  if (!dom.includes(liveName) || !dom.includes(startText))
    throw new Error('Board binding not verified; inspect loading state before further action');
  const evidence = { observed_at: new Date().toISOString(), row: text, board: added[0], dom };
  if (save) await save(evidence);
  return { board, evidence };
}
