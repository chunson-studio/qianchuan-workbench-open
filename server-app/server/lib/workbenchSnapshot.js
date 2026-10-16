'use strict';

// Read-only projection of the browser controller's existing atomic state file.
// No platform/service calls, ledger import, state repair or background collection.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const pending = value => ['dispatch_pending', 'submitted_pending_readback', 'unconfirmed'].includes(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' ? value.slice(0, 500) : null;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(value)
    ? value.replace(' ', 'T') + (value.length === 16 ? ':00' : '') + '+08:00' : value;
  const n = Date.parse(normalized);
  return Number.isFinite(n) ? n : null;
};
const sameBinding = (a, b) => ['advertiser_id', 'primary_ad_id', 'room_id', 'session_started_at'].every(k => a?.[k] === b?.[k]);
const sceneKey = b => JSON.stringify([b.advertiser_id, b.primary_ad_id, b.room_id, b.session_started_at]);

function operation(o) {
  return { request_id: text(o.request_id), task_id: text(o.task_id), action: text(o.action),
    status: text(o.status), at: text(o.verified_at || o.submitted_at || o.submit_started_at || o.queued_at) };
}

function projectState(state, accounts, source) {
  if (state?.schema_version !== 1 || !state.scenes || !state.operations) throw Error('invalid_state');
  const rows = [];
  for (const [key, scene] of Object.entries(state.scenes)) {
    const b = scene.binding;
    if (!b || !['advertiser_id', 'primary_ad_id', 'room_id'].every(k => /^\d+$/.test(b[k] || ''))
      || instant(b.session_started_at) === null || key !== sceneKey(b)) continue;
    const matching = accounts.filter(a => String(a.aavid || '') === b.advertiser_id && (!b.account_id || a.id === b.account_id));
    if (matching.length !== 1) continue;
    const account = matching[0];
    const rounds = Object.values(scene.rounds || {}).filter(r => sameBinding(r.binding, b));
    rounds.sort((a, z) => (instant(z.brief?.at) || 0) - (instant(a.brief?.at) || 0));
    const observation = scene.last_observation;
    const brief = sameBinding(observation?.brief?.binding, b) ? observation.brief : rounds.find(r => sameBinding(r.brief?.binding, b))?.brief;
    const board = brief?.board, basis = board?.metric_basis;
    const net = basis === 'platform_整体消耗_净成交ROI', marketing = basis === 'platform_综合成本_综合营销ROI';
    const ops = Object.values(state.operations).filter(o => o.session === key);
    const unresolved = ops.filter(o => pending(o.status));
    const currentRequests = new Set(observation?.operation_ids || []);
    const currentOps = ops.filter(o => currentRequests.has(o.request_id));
    const counters = Object.fromEntries(['create', 'pause', 'resume'].map(action => [action,
      currentOps.filter(o => o.action === action && o.status === 'write_verified').length]));
    const tasks = brief?.tasks, idColumn = tasks?.columns?.indexOf('id') ?? -1;
    const ids = new Set((tasks?.active || []).map(r => r[idColumn]));
    let countKnown = tasks?.coverage?.active === true && idColumn >= 0 && Array.isArray(tasks?.active)
      && ids.size === tasks.active.length && [...ids].every(v => typeof v === 'string' && /^\d+$/.test(v)) && !unresolved.length;
    const sampled = instant(tasks?.sampled_at?.[0]);
    // Only exact verified membership changes newer than the pool sample can adjust its total.
    for (const o of ops.filter(o => o.status === 'write_verified' && ['create', 'pause', 'resume', 'stop', 'delete'].includes(o.action))) {
      if (sampled !== null && instant(o.verified_at) !== null && instant(o.verified_at) < sampled) continue;
      const id = o.after?.task_id || o.task_id;
      if (sampled === null || instant(o.verified_at) === null || typeof id !== 'string' || !/^\d+$/.test(id)) { countKnown = false; continue; }
      if (['create', 'resume'].includes(o.action)) ids.add(id); else ids.delete(id);
    }
    const observedAt = text(brief?.at);
    rows.push({ id: hash([key]), account_id: account.id, account_name: account.name || account.id,
      binding: { advertiser_id: b.advertiser_id, primary_ad_id: b.primary_ad_id, room_id: b.room_id, session_started_at: b.session_started_at },
      name: text(b.live_name) || '直播间', source, revision: state.revision,
      captured_at: observedAt, financial_at: text(board?.captured_at),
      online_at: text(brief?.five?.captured_at || brief?.five?.observed_at || brief?.at),
      live_state: ['live', 'ended', 'unknown'].includes(scene.status) ? scene.status : 'unknown',
      execution: state.owner?.session === key ? { owner: text(state.owner.id), status: text(state.owner.status) } : null,
      metrics: { cost: number(net ? board?.overall_cost ?? board?.cost : board?.cost), gmv: number(board?.gmv),
        roi: number(net ? board?.net_transaction_roi ?? board?.net_roi : marketing ? board?.net_roi : null),
        roi_label: marketing ? '综合营销ROI' : net ? '净成交ROI' : 'ROI（口径未知）',
        cost_label: marketing ? '综合成本' : net ? '整体消耗' : '消耗（口径未知）',
        online: Number.isSafeInteger(brief?.five?.online) && brief.five.online >= 0 ? brief.five.online : null,
        active_tasks: countKnown ? ids.size : null },
      actions: counters, pending_count: unresolved.length,
      operations: ops.map(operation).sort((a, z) => (instant(z.at) || 0) - (instant(a.at) || 0)).slice(0, 20),
      rounds: rounds.slice(0, 10).map(r => ({ round_id: text(r.round_id), captured_at: text(r.brief?.at), display: text(r.display) })),
      issues: [...new Set((brief?.quality?.issues || []).map(x => text(x.code)).filter(Boolean))],
    });
  }
  return rows;
}

function createSnapshotReader({ roots, maxAgeMs = 300000, maxFileBytes = 64 * 1024 * 1024 }) {
  const cache = new Map();
  return function read(accounts, { now = Date.now() } = {}) {
    const rows = [], issues = [], seen = new Set();
    const accountIdentity = JSON.stringify(accounts.map(a => [a.id, a.aavid, a.name]));
    for (const root of [...new Set(roots.map(r => path.resolve(r)))]) {
      const directory = path.join(root, 'codex-control');
      let dirs;
      try {
        if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink()) throw Error('linked_root');
        dirs = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) { if (error.code !== 'ENOENT') issues.push({ code: 'local_source_unavailable' }); continue; }
      const candidates = dirs.filter(d => d.isDirectory() && /^[a-f0-9]{64}$/.test(d.name));
      if (candidates.length > 200) { issues.push({ code: 'local_source_limit' }); continue; }
      for (const d of candidates) {
        const file = path.join(directory, d.name, 'state.json');
        seen.add(file);
        try {
          const st = fs.lstatSync(file);
          if (!st.isFile() || st.isSymbolicLink() || st.size > maxFileBytes) throw Error('invalid_local_state');
          const signature = [st.mtimeMs, st.ctimeMs, st.size, accountIdentity].join('|');
          if (cache.get(file)?.signature !== signature) {
            const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
            const projected = projectState(state, accounts, 'codex_browser_state');
            if (projected.some(r => hash([r.binding.advertiser_id, r.binding.primary_ad_id]) !== d.name)) throw Error('state_path_binding_mismatch');
            cache.set(file, { signature, rows: projected });
          }
          rows.push(...cache.get(file).rows);
        } catch { cache.delete(file); issues.push({ code: 'local_state_unreadable' }); }
      }
    }
    for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
    const counts = new Map(); rows.forEach(r => counts.set(r.id, (counts.get(r.id) || 0) + 1));
    const unique = new Map();
    for (const original of rows) {
      if (unique.has(original.id)) continue;
      const row = structuredClone(original), captured = instant(row.captured_at);
      const timestamps = [row.captured_at, row.financial_at, row.online_at].map(instant);
      row.age_seconds = captured === null ? null : Math.max(0, Math.floor((now - captured) / 1000));
      row.freshness = timestamps.some(t => t === null || t > now + 5000) ? 'unknown'
        : timestamps.some(t => now - t > maxAgeMs) ? 'stale' : 'current';
      if (counts.get(row.id) > 1) {
        row.freshness = 'unknown'; row.issues.push('local_source_conflict');
        for (const key of ['cost', 'gmv', 'roi', 'online', 'active_tasks']) row.metrics[key] = null;
        row.actions = null; row.operations = []; row.rounds = []; row.execution = null; row.pending_count = null;
      }
      unique.set(row.id, row);
    }
    return { schema_version: 1, generated_at: new Date(now).toISOString(), source: 'local_only',
      max_age_seconds: maxAgeMs / 1000, accounts: accounts.map(a => ({ id: a.id, name: a.name || a.id })),
      sessions: [...unique.values()].sort((a, b) => (instant(b.binding.session_started_at) || 0) - (instant(a.binding.session_started_at) || 0)),
      issues, upstream_requests: 0 };
  };
}
module.exports = { createSnapshotReader, projectState };
