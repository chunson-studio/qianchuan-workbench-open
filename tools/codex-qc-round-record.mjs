// Local CUA receipt finalization only; no browser, network, advertising or scheduling actions.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { calculateRoundDeltas } from './codex-qc-decision-brief.mjs';
import { reconcileFeedback } from './codex-qc-feedback.mjs';

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''));

function assertSameBinding(previous, current) {
  for (const key of ['advertiser_id', 'primary_ad_id', 'room_id', 'date', 'session_started_at']) {
    if (previous?.[key] !== current?.[key]) throw new Error(`Round binding changed: ${key}`);
  }
}

export function summarizeRound(previous, current) {
  assertSameBinding(previous.binding, current.binding);
  if (time(current.captured_at) === null || time(previous.captured_at) === null
      || time(current.captured_at) <= time(previous.captured_at)) throw new Error('Round time must advance');
  if (!Array.isArray(current.actions) || !current.decision) throw new Error('Explicit actions and model decision required');
  const poolTasks = round => [...(round.active_pool?.tasks ?? []), ...(round.paused_pool?.tasks ?? [])];
  for (const task of poolTasks(current)) {
    if (typeof task.task_id !== 'string') throw new Error('Task IDs must remain strings');
  }
  const computed = calculateRoundDeltas(previous, current);
  const { gmv, ...rest } = computed.board;
  const delta = { normal_gmv: gmv, ...rest };
  const taskDeltas = computed.tasks.map(task => ({ ...task, rate_basis: 'displayed snapshot delta; reporting delay may apply' }));
  const feedback = reconcileFeedback(previous, current);
  return { ...current, delta, deltas: delta, task_deltas: taskDeltas, pending_queue: feedback.pending,
    completed_startup_feedback: feedback.completed, feedback_issues: feedback.issues,
    comparison: { compass_same_scene: computed.comparison.same_scene,
      pools_complete: computed.comparison.pools_complete, ...computed.comparison },
    previous_compass: previous.compass };
}

export async function saveRound({ scene_dir, round_dir, previous, current, state_text, learning_text }) {
  const scene = path.resolve(scene_dir), directory = path.resolve(round_dir);
  const relative = path.relative(scene, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Round directory must be inside scene');
  if (typeof state_text !== 'string' || !state_text.trim()) throw new Error('Model-authored current state required');
  const result = summarizeRound(previous, { ...current, finalized_at: new Date().toISOString() });
  await fs.mkdir(directory, { recursive: true });
  const full = path.join(directory, 'full-round.json');
  await fs.writeFile(full, JSON.stringify(result, null, 2), 'utf8');
  const latest = path.join(scene, 'codex-latest-round.json');
  const onDisk = parse(await fs.readFile(latest, 'utf8'));
  // Optimistic conflict check, not a process mutex. Preserve evidence if another round advanced.
  assertSameBinding(previous.binding, onDisk.binding);
  if (onDisk.captured_at !== previous.captured_at) throw new Error('Latest receipt advanced; preserved full round, did not overwrite current state');
  await fs.writeFile(latest, JSON.stringify(result, null, 2), 'utf8');
  await fs.writeFile(path.join(scene, '运行状态.md'), state_text, 'utf8');
  if (typeof learning_text === 'string' && learning_text.trim()) await fs.appendFile(path.join(scene, '账户反馈学习.md'), `\n\n${learning_text.trim()}\n`, 'utf8');
  return { result, full_round: full, latest, ad_actions_performed: 0 };
}
