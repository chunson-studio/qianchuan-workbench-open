
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function createStepRecorder(tab, binding, { capture_screenshots = false } = {}) {
  if (!tab?.playwright?.domSnapshot || (capture_screenshots && !tab?.screenshot) || !binding?.advertiser_id || !binding?.profile_name)
    throw Error('Explicit CUA tab and account/profile binding required');
  const dir = await fs.mkdtemp(path.join(root, 'work/browser-actions/runs/record-'));
  const frames = [];
  const frozenBinding = Object.freeze(structuredClone(binding));
  async function checkpoint(name, status = 'observed', details = {}) {
    const stem = String(frames.length + 1).padStart(3, '0');
    const observed_at = new Date().toISOString();
    const screenshot = capture_screenshots ? await tab.screenshot({ fullPage: false }) : null;
    const dom = await tab.playwright.domSnapshot();
    const captured_at = new Date().toISOString();
    if (screenshot) await fs.writeFile(path.join(dir, stem + '.png'), screenshot, { flag: 'wx' });
    await fs.writeFile(path.join(dir, stem + '.dom.txt'), dom, { flag: 'wx' });
    const item = { id: `record.${stem}`, channel: 'codex-cua', name, status, binding: frozenBinding,
      page: await tab.url(), entry: details.entry ?? null, locator: details.locator ?? null,
      observed_at, captured_at, success_evidence: details.evidence ?? null, exit: 'page_left_open',
      constraints: [...(screenshot ? ['Screenshot and DOM are sequential observations.'] : []), 'Recording does not prove account identity unless independently verified.'],
      sources: [...(screenshot ? [stem + '.png'] : []), stem + '.dom.txt'], screenshot: screenshot ? stem + '.png' : null, dom: stem + '.dom.txt',
      screenshot_sha256: screenshot ? createHash('sha256').update(screenshot).digest('hex') : null,
      dom_sha256: createHash('sha256').update(dom).digest('hex'), details };
    await fs.writeFile(path.join(dir, stem + '.json'), JSON.stringify(item, null, 2), { flag: 'wx' });
    const readback = JSON.parse(await fs.readFile(path.join(dir, stem + '.json'), 'utf8'));
    if (readback.dom_sha256 !== item.dom_sha256 || readback.screenshot_sha256 !== item.screenshot_sha256) throw Error('Recording readback failed');
    frames.push(item);
    await fs.writeFile(path.join(dir, 'frames.json'), JSON.stringify(frames, null, 2));
    return item;
  }
  return { dir, checkpoint };
}
