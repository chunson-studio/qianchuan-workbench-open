'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cfg = require('./config');
const { serialiseMutation, readConfig, createAccount, getConfigVersion } = require('./accountRegistry');
const { commitAccountFiles, contentVersion } = require('./accountPersistence');
const { buildDefaultProfile, normalizeAccountProfile } = require('./accountProfile');
const { parseCookieEditor } = require('./cookieImport');
const { discoverAccount, requestAccountInfo, extractCandidates } = require('./accountDiscovery');
const { readQcCookie } = require('./cookie');
const { ROI_BASES, inferRoiGoalBasis, extractOptimizationMetadata } = require('./roiBasis');

const ACTIONS = ['plan_roi', 'plan_budget', 'boost_create', 'boost_update', 'boost_pause', 'boost_resume', 'boost_delete', 'flow_control', 'volume_start', 'material_remove'];
const QUESTIONS = [
  { key: 'objective', label: '这次主要想改善什么？', type: 'text', group: 'goals' },
  { key: 'target_roi', label: '希望达到的经营 ROI（不清楚可留空）', type: 'number', group: 'goals' },
  { key: 'roi_basis', label: '经营 ROI 口径', type: 'select', options: ROI_BASES, group: 'goals' },
  { key: 'break_even_roi', label: '财务保本 ROI（不清楚可留空）', type: 'number', group: 'finance' },
  { key: 'break_even_basis', label: '保本 ROI 口径', type: 'select', options: ROI_BASES, group: 'finance' },
  { key: 'daily_budget', label: '每天最多消耗多少元？', type: 'number', group: 'budget' },
  { key: 'session_budget', label: '每场最多消耗多少元？', type: 'number', group: 'budget' },
  { key: 'test_loss', label: '每场可接受的测试损耗上限（元）', type: 'number', group: 'budget' },
  { key: 'allowed_actions', label: '希望 Agent 操作的范围（可留空）', type: 'actions', options: ACTIONS, group: 'authorization' },
  { key: 'forbidden_actions', label: '明确禁止的动作', type: 'actions', options: ACTIONS, group: 'authorization' },
  { key: 'notifications', label: '什么时候通知你？', type: 'select', options: ['important_only', 'every_round'], group: 'notifications' },
];
function error(code, message, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
function paths(options = {}) {
  const configPath = options.configPath || cfg.CONFIG_PATH;
  return { ...options, configPath, root: path.dirname(configPath), profileDir: options.profileDir || cfg.ACCOUNT_PROFILES_DIR,
    scriptsDir: options.scriptsDir || cfg.SCRIPTS_DIR, applyRegistry: options.applyRegistry || cfg.applyAccountRegistry };
}
function load(id, options) {
  const opts = paths(options), config = readConfig(opts.configPath);
  const account = (config.qianchuan_accounts || []).find(item => item.id === id);
  if (!account) throw error('account_not_found', '请先选择或接入账户', 404);
  const profilePath = path.join(opts.profileDir, account.id + '.json');
  const profileText = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : null;
  const profile = profileText !== null ? normalizeAccountProfile(JSON.parse(profileText), account) : buildDefaultProfile(account);
  const draftPath = path.join(opts.root, 'onboarding', account.id + '.json');
  const draftText = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf8') : null;
  const draft = draftText !== null ? JSON.parse(draftText) : {
    version: 1, revision: 0, answers: {}, answered: [], observations: null, rehearsal: null,
  };
  // 已保存的答案作为起点，读取本身不写任何配置。
  if (!fs.existsSync(draftPath) && profile.onboarding?.answers) {
    draft.answers = profile.onboarding.answers;
    draft.answered = profile.onboarding.answered || Object.keys(draft.answers);
  }
  if (!fs.existsSync(draftPath) && !profile.onboarding?.answers) {
    const known = {
      objective: profile.operating?.objective, target_roi: profile.operating?.target_roi,
      roi_basis: profile.operating?.roi_basis || profile.metrics.roi_basis,
      break_even_roi: profile.metrics.break_even_roi, break_even_basis: profile.metrics.break_even_roi_basis || (profile.metrics.break_even_roi != null ? profile.metrics.roi_basis : undefined),
      daily_budget: profile.operating?.daily_budget_yuan, session_budget: profile.operating?.session_budget_yuan,
      test_loss: profile.operating?.test_loss_limit_yuan, notifications: profile.operating?.notifications,
    };
    for (const [key, value] of Object.entries(known)) if (value != null && value !== 'unknown') {
      draft.answers[key] = value; draft.answered.push(key);
    }
  }
  return { opts, config, account, profile, profilePath, draft, draftPath, profileVersion: contentVersion(profileText), draftVersion: contentVersion(draftText) };
}
function officialManual() {
  const candidates = [process.env.QC_OFFICIAL_SKILL_DIR,
    ...['.agents', '.hanako', '.codex'].map(root => path.join(os.homedir(), root, 'skills', 'qianchuan-ops'))].filter(Boolean);
  const directory = candidates.find(dir => fs.existsSync(path.join(dir, 'SKILL.md')));
  return { available: !!directory, skill: 'qianchuan-ops', path: directory ? path.join(directory, 'SKILL.md') : null,
    purpose: '只核验官方规则；账户目标与授权由项目保存' };
}
function validateAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('invalid_answers', '回答应为字段对象');
  const answers = {};
  for (const [key, raw] of Object.entries(input)) {
    // Accept saved legacy preferences without making them an execution gate.
    if (key === 'mode' && ['agent_decides', 'recommendation_only', 'confirm_writes', 'auto_guarded'].includes(raw)) {
      answers[key] = raw;
      continue;
    }
    const q = QUESTIONS.find(item => item.key === key);
    if (!q) throw error('unknown_answer', '包含不支持的配置项');
    if (q.type === 'number') {
      if (raw == null || raw === '') answers[key] = null;
      else if (!['number', 'string'].includes(typeof raw) || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 1e9
        || (key.includes('roi') && Number(raw) === 0)) throw error('invalid_number', q.label + '：请输入有效数值或留空');
      else answers[key] = Number(raw);
    } else if (q.type === 'select') {
      if (!q.options.includes(raw)) throw error('invalid_choice', q.label + '：选项无效');
      answers[key] = raw;
    } else if (q.type === 'actions') {
      if (!Array.isArray(raw) || raw.some(item => !ACTIONS.includes(item))) throw error('invalid_actions', '动作范围无效');
      answers[key] = [...new Set(raw)];
    } else {
      if (typeof raw !== 'string' || raw.length > 500 || /(?:sessionid|sid_tt|csrftoken|cookie\s*[:=]|bearer\s+|sk-[A-Za-z0-9])/i.test(raw)) throw error('invalid_text', '请只填写经营目标，不要填写凭据');
      answers[key] = raw.trim() || null;
    }
  }
  return answers;
}
function authorization(draft) {
  return { decision_owner: 'agent', enforced_by_workbench: false,
    requested_mode: draft.answers.mode || null, effective_mode: 'agent_decides',
    allowed_actions: draft.answers.allowed_actions || [], requested_actions: draft.answers.allowed_actions || [],
    forbidden_actions: draft.answers.forbidden_actions || [], write_blockers: [],
    explanation: '工作台保存用户偏好；Agent 根据用户指令决定读取、操作及何时确认。' };
}
function publicState(state) {
  const { account, profile, draft } = state;
  const missing = QUESTIONS.filter(q => !draft.answered.includes(q.key));
  const group = missing[0]?.group;
  const current = draft.observations?.plans?.find(item => item.id === draft.primary_ad_id) || null;
  const fresh = !!draft.observations?.checked_at && Date.now() - Date.parse(draft.observations.checked_at) < 10 * 60 * 1000;
  return { account: { id: account.id, name: account.name, aavid: account.aavid }, revision: draft.revision,
    stage: profile.onboarding?.state === 'configured' && !missing.length ? 'configured' : 'draft',
    answers: draft.answers, answered: draft.answered, missing: missing.map(q => q.key), next_questions: missing.filter(q => q.group === group), questions: QUESTIONS,
    platform_current: current, observations: draft.observations, observations_fresh: fresh,
    primary_ad_id: draft.primary_ad_id || account.primary_ad_id || null,
    authorization: authorization(draft), existing_execution_mode: profile.safety.mode,
    rehearsal: draft.rehearsal, derived: { flow_capacity: null, material_candidates: null, time_slot_performance: null, reason: '未自动推导；历史资料按需读取' },
    official_manual: officialManual(),
  };
}
function getStatus(id, options) {
  if (id) return publicState(load(id, options));
  const config = readConfig(paths(options).configPath);
  const accounts = (config.qianchuan_accounts || []).map(a => ({ id: a.id, name: a.name, aavid: a.aavid }));
  return { first_use: accounts.length === 0, accounts, questions: QUESTIONS, official_manual: officialManual(),
    login_url: 'https://qianchuan.jinritemai.com/login',
    credential_input: '在本场浏览器登录，由 Codex 核验并接续；不提供手动 Cookie 导入' };
}
async function importCredential(json, options = {}) {
  const discoveryOptions = { ...(options.discoveryOptions || {}) };
  if (options.advertiser_id != null) discoveryOptions.aavid = options.advertiser_id;
  return discoverAccount(parseCookieEditor(json), discoveryOptions);
}
async function selectAccount(input, options = {}) {
  return createAccount(input, { ...paths(options), upsert: true, targetAccountId: input.account_id });
}
async function importCompassCredential(id, json, options) {
  const header = parseCookieEditor(json, Date.now(), 'compass.jinritemai.com');
  const roomId = options?.room_id;
  if (roomId != null && !/^\d{5,30}$/.test(String(roomId))) throw error('invalid_room', '罗盘 room_id 必须是数字串');
  return serialiseMutation(() => {
    const state = load(id, options);
    const suffix = roomId ? `_room_${roomId}` : '';
    const file = path.join(state.opts.scriptsDir, `compass_cookie_${state.account.id}${suffix}.txt`);
    commitAccountFiles(state.opts.root, [{ file, text: header }]);
    return { account_id: state.account.id, ...(roomId ? { room_id: String(roomId) } : {}), saved: true, verified: false };
  });
}
function persistDraft(state) {
  state.draft.revision++;
  state.draft.updated_at = new Date().toISOString();
  commitAccountFiles(state.opts.root, [{ file: state.draftPath, text: JSON.stringify(state.draft, null, 2), expectedVersion: state.draftVersion }]);
  return publicState(state);
}
async function updateDraft(id, input, options) {
  return serialiseMutation(() => {
    const state = load(id, options);
    if (input.revision !== state.draft.revision) throw error('draft_conflict', '配置已发生变化，请重新读取后继续', 409);
    const answers = validateAnswers(input.answers || {});
    state.draft.answers = { ...state.draft.answers, ...answers };
    state.draft.answered = [...new Set([...state.draft.answered, ...Object.keys(answers)])];
    if (Object.hasOwn(input, 'primary_ad_id')) {
      const selected = input.primary_ad_id;
      if (selected !== null && !state.draft.observations?.plans?.some(p => p.id === selected && p.ownership_verified)) throw error('plan_identity_mismatch', '所选计划不在本次已验证账户的计划列表中');
      state.draft.primary_ad_id = selected;
    }
    state.draft.rehearsal = null;
    return persistDraft(state);
  });
}
function finite(value, divisor = 1) { return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value) / divisor; }
function extractPlans(payload, aavid, checkedAt) {
  const rows = payload?.data?.adInfos;
  if (!Array.isArray(rows)) throw error('plan_schema_changed', '计划列表格式无法核验', 502);
  return rows.filter(row => (typeof row.id !== 'number' || Number.isSafeInteger(row.id)) && /^\d{5,30}$/.test(String(row.id)) && (!row.aavid || String(row.aavid) === aavid)).map(row => ({
    id: String(row.id), name: String(row.name || row.adName || row.id).slice(0, 150),
    roi_goal: finite(row.ecpRoi2Goal), roi_basis: inferRoiGoalBasis(row).basis,
    bid: finite(row.bid, 100000), bid_unit: 'yuan', budget: finite(row.budget, 100000), budget_unit: 'yuan',
    status: row.status ?? null, optimization: extractOptimizationMetadata(row),
    ownership_verified: true, source: 'account_scoped_uni_promotion_list', source_at: checkedAt,
  }));
}
async function rehearse(id, options = {}) {
  const initial = load(id, options), revision = initial.draft.revision;
  const cookie = options.cookieReader ? options.cookieReader(id) : readQcCookie(id);
  if (!cookie) throw error('cookie_missing', '请先导入本账户 Cookie');
  const discoveryOptions = { ...options, aavid: String(initial.account.aavid) };
  const identity = await (options.identity ? options.identity(cookie, discoveryOptions) : requestAccountInfo(cookie, discoveryOptions));
  if (Number(identity?.status_code ?? identity?.code ?? 0) !== 0) throw error('cookie_rejected', '千川拒绝了登录验证', 401);
  if (!extractCandidates(identity).some(a => a.aavid === String(initial.account.aavid))) throw error('account_identity_mismatch', '当前 Cookie 无法证明属于所选账户，未启用投放', 409);
  const { fetchLiveStatus } = require('./qianchuanTabs');
  const { fetchLivePlanList } = require('./chengfangLive');
  const { getAccountBalance } = require('./qianchuan');
  const { getLocalDateStr } = require('./utils');
  const today = getLocalDateStr();
  const calls = {
    plans: options.plans || (() => fetchLivePlanList(today, today, id)),
    live: options.live || (() => fetchLiveStatus(id)), balance: options.balance || (() => getAccountBalance(id)),
  };
  const components = {};
  await Promise.all(Object.entries(calls).map(async ([key, call]) => {
    try {
      const value = await call();
      if (value?.ok === false || Number(value?.status_code ?? value?.code ?? 0) !== 0) throw error('upstream_rejected', '读取未通过');
      components[key] = { value, checked_at: new Date().toISOString(), valid: true };
    } catch (e) { components[key] = { value: null, checked_at: new Date().toISOString(), valid: false, error: '只读读取失败', code: /^[a-z_]{1,64}$/.test(e.code || '') ? e.code : 'read_unavailable' }; }
  }));
  return serialiseMutation(() => {
    const state = load(id, options);
    if (state.draft.revision !== revision) throw error('draft_conflict', '预演期间配置有变化，请重试', 409);
    const checkedAt = new Date().toISOString();
    let plans = [];
    if (components.plans.valid) {
      try { plans = extractPlans(components.plans.value, String(state.account.aavid), components.plans.checked_at); }
      catch { components.plans.valid = false; components.plans.code = 'plan_schema_changed'; }
    }
    const configuredId = state.draft.primary_ad_id || state.account.primary_ad_id;
    const selected = plans.find(p => p.id === configuredId);
    // 一个可见计划仍展示给用户确认；多计划绝不按排序任选。
    state.draft.primary_ad_id = selected?.id || (plans.length === 1 && !configuredId ? plans[0].id : null);
    const rawLive = components.live.value;
    const isLive = typeof rawLive?.isLive === 'boolean' ? rawLive.isLive : typeof rawLive?.is_live === 'boolean' ? rawLive.is_live : null;
    const wallets = components.balance.value?.data?.balanceInfos;
    const balance = wallets && Object.values(wallets).length && Object.values(wallets).every(w => finite(w.valid) !== null)
      ? Object.values(wallets).reduce((sum, w) => sum + finite(w.valid, 100000), 0) : null;
    state.draft.observations = { checked_at: checkedAt, identity_verified: true, plans,
      live: { is_live: isLive, dataValid: isLive !== null, source_at: rawLive?.source_at || rawLive?.fetched_at || null, checked_at: components.live.checked_at },
      balance: { available_yuan: balance, dataValid: balance !== null, checked_at: components.balance.checked_at },
      components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, { valid: value.valid, checked_at: value.checked_at, code: value.code || null }])),
      plan_conflict: !!configuredId && !selected };
    state.draft.rehearsal = { id: crypto.randomUUID(), checked_at: checkedAt, operation: 'account_preflight', advertising_writes: 0,
      identity_verified: true, partial: Object.values(components).some(v => !v.valid),
      primary_plan_verified: !!state.draft.primary_ad_id, configuration_revision: revision + 1 };
    state.draft.credential_fingerprint = crypto.createHash('sha256').update(cookie).digest('hex');
    return persistDraft(state);
  });
}
async function save(id, input, options) {
  return serialiseMutation(() => {
    const state = load(id, options), { draft, account, profile, config, opts } = state;
    if (input.revision !== draft.revision) throw error('draft_conflict', '配置已变化，请重新预览', 409);
    if (input.confirm !== true) throw error('confirmation_required', '请确认预览后保存');
    if (!draft.rehearsal?.identity_verified || Date.now() - Date.parse(draft.rehearsal.checked_at) > 10 * 60 * 1000) throw error('rehearsal_required', '请先完成十分钟内的只读预演');
    const credential = opts.cookieReader ? opts.cookieReader(id) : readQcCookie(id);
    if (!credential || crypto.createHash('sha256').update(credential).digest('hex') !== draft.credential_fingerprint) throw error('credentials_changed', '凭据已经变化，请重新只读预演', 409);
    const a = draft.answers, auth = authorization(draft);
    profile.metrics = { ...profile.metrics, roi_basis: a.break_even_basis || profile.metrics.roi_basis || 'unknown',
      break_even_roi: a.break_even_roi ?? null, break_even_roi_basis: a.break_even_basis || 'unknown' };
    profile.operating = { objective: a.objective ?? null, target_roi: a.target_roi ?? null, roi_basis: a.roi_basis || 'unknown',
      daily_budget_yuan: a.daily_budget ?? null, session_budget_yuan: a.session_budget ?? null, test_loss_limit_yuan: a.test_loss ?? null,
      notifications: a.notifications || 'important_only', source: 'user_confirmed', updated_at: new Date().toISOString() };
    profile.safety = { ...profile.safety, mode: auth.effective_mode };
    profile.onboarding = { version: 1, managed: true, state: 'configured', answers: a, answered: draft.answered, authorization: auth,
      rehearsal: draft.rehearsal, technical_defaults: { decision_owner: 'agent', roi_lock_minutes: profile.bidding.roi_lock_minutes },
      confirmed_at: new Date().toISOString() };
    profile.calibration = { ...profile.calibration, status: 'draft', notes: '账户接入完成；经营阈值是否可用由 Agent 结合证据判断。' };
    if (draft.primary_ad_id) {
      account.primary_ad_id = draft.primary_ad_id;
      profile.account.primary_ad_id = draft.primary_ad_id;
    }
    config.account_config = { ...(config.account_config || {}), [id]: { ...(config.account_config?.[id] || {}), break_even_roi: a.break_even_roi ?? null } };
    commitAccountFiles(opts.root, [
      { file: state.profilePath, text: JSON.stringify(profile, null, 2) + '\n', expectedVersion: state.profileVersion },
      { file: state.draftPath, text: JSON.stringify(draft, null, 2), expectedVersion: state.draftVersion },
      { file: opts.configPath, text: JSON.stringify(config, null, 2) + '\n', expectedVersion: getConfigVersion(config) },
    ], () => opts.applyRegistry(config));
    return { ...publicState(state), saved: true, account_ready: true, authorization: auth };
  });
}
module.exports = { QUESTIONS, ACTIONS, getStatus, importCredential, importCompassCredential, selectAccount, updateDraft, rehearse, save, validateAnswers, extractPlans, officialManual };
