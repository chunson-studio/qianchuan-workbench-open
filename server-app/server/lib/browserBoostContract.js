'use strict';
const ACTIONS = Object.freeze(['list', 'detail', 'diagnose', 'create', 'pause', 'resume', 'stop', 'delete',
  'update_status', 'update_budget', 'update_duration', 'update_roi', 'update_bid', 'update_audience']);
const READS = new Set(['list', 'detail', 'diagnose']);
const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), {
  code, statusCode, advertising_writes: 0, effect_status: 'rejected', retry_write: false,
}); };
function normalizeRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_browser_request', '需要 JSON 对象');
  const allowed = new Set(['account_id','action','primary_ad_id','target_id','target_ids','session_key','execution_owner',
    'expected_budget','duration_seconds','expected_duration_seconds','value','budget','roi_goal','roi_basis','bid',
    'audience_template','live_feed','request_id','duration','name','smart_bid_type','mar_goal','mids','start','end','assist_task','slim','preview']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('unsupported_browser_parameter', '请求含未知字段；浏览器端点不接收定位器、脚本或连接地址');
  const r = { ...input };
  if (!ACTIONS.includes(r.action)) fail('invalid_boost_action', '未知追投动作');
  for (const key of ['account_id', 'primary_ad_id']) if (typeof r[key] !== 'string' || !r[key]) fail('browser_binding_required', '浏览器调用必须显式传 ' + key);
  if (!/^[A-Za-z0-9_-]+$/.test(r.account_id) || !/^\d+$/.test(r.primary_ad_id)) fail('invalid_browser_binding', '账户或主计划格式无效');
  if (r.action === 'update_status') {
    r.action = ({ 1: 'resume', 2: 'pause', 6: 'stop' })[r.value];
    if (!r.action) fail('invalid_boost_status', '状态只接受1、2、6');
    delete r.value;
  }
  if (r.target_ids !== undefined) fail('browser_batch_detail_not_supported', '浏览器通道每次绑定一个任务；逐条调用 detail');
  if (!['list','diagnose','create'].includes(r.action) && (typeof r.target_id !== 'string' || !/^\d+$/.test(r.target_id))) fail('target_required', '必须传追投任务 ID');
  if (r.preview !== undefined && typeof r.preview !== 'boolean') fail('invalid_preview', 'preview必须是布尔值');
  r.preview = r.preview === true;
  if (!READS.has(r.action) && !r.preview && !/^[A-Za-z0-9_-]{8,100}$/.test(r.request_id || '')) fail('request_id_required', '浏览器写入必须绑定8~100位请求编号');
  if ((r.execution_owner && !r.session_key) || (r.session_key && !r.execution_owner && !READS.has(r.action))) fail('execution_identity_incomplete', '写入的 session_key 与 execution_owner须配对');
  if (r.action !== 'create' && r.duration !== undefined) fail('create_duration_field_not_allowed', 'duration只用于新建；更新使用duration_seconds');
  if (r.action !== 'update_duration' && (r.duration_seconds !== undefined || r.expected_duration_seconds !== undefined)) fail('duration_action_required', '总时长参数只用于update_duration');
  const positive = (value, key) => { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('invalid_' + key, key + '须为正数'); };
  if (r.action === 'update_duration') {
    if (!Number.isSafeInteger(r.duration_seconds) || r.duration_seconds < 1800 || r.duration_seconds > 86400 || r.duration_seconds % 1800 !== 0
      || !Number.isSafeInteger(r.expected_duration_seconds) || r.expected_duration_seconds <= 0) fail('invalid_duration_seconds', '总时长1800~86400秒、半小时步进，须传实际旧秒数');
    if (['value','budget','expected_budget','roi_goal','roi_basis','bid','audience_template'].some(key => r[key] !== undefined)) fail('mixed_parameter_update_not_allowed', '时长须单独修改');
  }
  if (r.action === 'update_budget') {
    if (r.value !== undefined && r.budget !== undefined && r.value !== r.budget) fail('budget_alias_conflict', 'value和budget均表示新总预算');
    r.budget = r.budget ?? r.value; delete r.value;
    positive(r.budget, 'budget'); positive(r.expected_budget, 'expected_budget');
  }
  if (r.action === 'update_roi') { if(r.value!=null && r.roi_goal!=null && r.value!==r.roi_goal)fail('roi_alias_conflict','ROI参数冲突'); r.roi_goal = r.roi_goal ?? r.value; delete r.value; positive(r.roi_goal, 'roi_goal'); if (r.roi_goal > 100) fail('invalid_roi_goal', 'ROI不得超过100'); }
  if (r.action === 'update_bid') { if(r.value!=null && r.bid!=null && r.value!==r.bid)fail('bid_alias_conflict','出价参数冲突'); r.bid = r.bid ?? r.value; delete r.value; positive(r.bid, 'bid'); if (r.bid < 15 || r.bid > 35) fail('invalid_bid', '手动出价15~35元'); }
  if (r.action === 'update_audience' && r.audience_template !== 'full_region') fail('audience_template_required', '只支持已登记full_region定向模板');
  if (r.action === 'create') {
    for (const key of ['live_feed','assist_task']) if (r[key] !== undefined && typeof r[key] !== 'boolean') fail('invalid_create_shape', key + '必须是布尔值');
    if (r.live_feed && (r.assist_task || (r.mids !== undefined && (!Array.isArray(r.mids) || r.mids.length)))) fail('invalid_create_shape', '直播画面不能混入素材或一键起量形态');
    positive(r.budget, 'budget');
    if(r.roi_goal!=null){positive(r.roi_goal,'roi_goal');if(r.roi_goal>100)fail('invalid_roi_goal','ROI不得超过100');}
    if(r.bid!=null)positive(r.bid,'bid');
    if(r.smart_bid_type!=null && !['0','7'].includes(r.smart_bid_type))fail('invalid_bidding_mode','仅支持已登记的控成本或放量模式');
    if(r.mar_goal!=null && !['1','2'].includes(r.mar_goal))fail('invalid_marketing_goal','营销目标只接受1或2');
    if((r.smart_bid_type==='7'||r.live_feed===true||r.mar_goal==='1') && (r.roi_goal!=null||r.bid!=null))fail('bidding_mode_conflict','放量参数不能混入ROI或手动出价');
    const volume = r.smart_bid_type === '7' || r.live_feed === true || r.mar_goal === '1' || r.assist_task === true;
    if (volume ? r.budget < 100 : r.budget <= 100) fail('invalid_budget', volume ? '放量至少100元' : '控成本预算须大于100元');
    if (volume && (!Number.isSafeInteger(r.duration) || r.duration < 60 || r.duration > 86400)) fail('invalid_create_duration', '放量总时长60~86400秒');
    if (!r.assist_task && !r.live_feed && (!Array.isArray(r.mids) || !r.mids.length || r.mids.length > 50 || r.mids.some(id => typeof id !== 'string' || !/^\d+$/.test(id)))) fail('materials_required', '素材追投须传1~50个素材 ID');
    if (r.assist_task && (r.budget > 5000 || r.mids?.length || r.roi_goal != null || r.bid != null)) fail('invalid_assist_task', '起量100~5000元，无素材、ROI和出价维度');
    if (r.roi_goal != null && r.bid != null) fail('bidding_mode_conflict', 'ROI与手动出价互斥');
    if (!volume && r.bid == null) { positive(r.roi_goal, 'roi_goal'); if (r.roi_goal > 100) fail('invalid_roi_goal', 'ROI不得超过100'); }
    if (r.bid != null && (r.bid < 15 || r.bid > 35 || r.budget > 300 || r.mar_goal === '1')) fail('invalid_manual_bid', '手动出价15~35元，预算不超过300，限直播');
    if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 50) fail('create_name_required', '浏览器新建须传1~50字唯一任务名，便于同对象回读');
    if (r.live_feed) fail('browser_live_feed_pending_verification', '直播画面追投入口尚待本通道验证；未连接浏览器或提交，不改走素材追投', 423);
  }
  const fieldsForAction = {
    update_budget: ['budget','expected_budget'], update_roi: ['roi_goal','roi_basis'], update_bid: ['bid'],
    update_audience: ['audience_template'], update_duration: ['duration_seconds','expected_duration_seconds'],
  };
  const updateFields = ['budget','expected_budget','roi_goal','roi_basis','bid','audience_template','duration_seconds','expected_duration_seconds','value'];
  if (r.action !== 'create' && updateFields.some(key => r[key] !== undefined && !fieldsForAction[r.action]?.includes(key))) fail('mixed_parameter_update_not_allowed', '每次仅修改当前动作对应参数');
  if (r.roi_basis != null && !['payment','platform_net_1h','chengfang_comprehensive'].includes(r.roi_basis)) fail('invalid_roi_basis', 'ROI口径须明确且可由平台核验');
  for (const key of ['start','end']) if (r[key] !== undefined) {const date=new Date(r[key]+'T00:00:00Z');if(typeof r[key]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r[key])||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==r[key])fail('invalid_date_range','日期格式无效');}
  if (r.start && r.end && r.start > r.end) fail('invalid_date_range', '日期顺序无效');
  return r;
}
function legacyWrite(r) {
  const body = { accountId: r.account_id, primaryAdId: r.primary_ad_id, ...(r.target_id ? { assistTaskId: r.target_id } : {}) };
  if (r.action === 'create') return { pathname: '/api/boost-create', body: { ...body, budget: r.budget, duration: r.duration } };
  if (r.action === 'delete') return { pathname: '/api/boost-delete', body };
  if (['pause','resume','stop'].includes(r.action)) return { pathname: '/api/campaign/status', body: { ...body, status: ({ pause: 2, resume: 1, stop: 6 })[r.action] } };
  return { pathname: '/api/campaign/budget', body: { ...body,
    ...(r.action === 'update_budget' ? { budget: r.budget, expectedBudget: r.expected_budget } : {}),
    ...(r.action === 'update_duration' ? { durationSeconds: r.duration_seconds, expectedDurationSeconds: r.expected_duration_seconds } : {}),
    ...(r.action === 'update_roi' ? { roiGoal: r.roi_goal } : {}), ...(r.action === 'update_bid' ? { bid: r.bid } : {}),
    ...(r.action === 'update_audience' ? { audienceTemplate: r.audience_template } : {}) } };
}
function requestedValues(r) {
  if (r.action === 'create') return { budget: r.budget, ...(r.duration != null ? { duration_seconds: r.duration } : {}),
    ...(r.roi_goal != null ? { roi_goal: r.roi_goal } : {}), ...(r.bid != null ? { bid: r.bid } : {}), name: r.name, ...(r.mids?.length ? { material_ids: [...r.mids].sort() } : {}) };
  return ({ pause: { status: 2 }, resume: { status: 1 }, stop: { status: 6 }, delete: { status: 99 },
    update_budget: { budget: r.budget }, update_duration: { duration_seconds: r.duration_seconds },
    update_roi: { roi_goal: r.roi_goal }, update_bid: { bid: r.bid }, update_audience: { audience: { template: r.audience_template } } })[r.action] || {};
}
class OperationDeadline {
  constructor(totalMs = 50000, now = Date.now) { this.now = now; this.started = now(); this.deadline = this.started + totalMs; this.timings = {}; }
  timeout(maxMs) { const remaining = this.deadline - this.now(); if (remaining <= 0) fail('browser_operation_timeout', '本次操作期限已到', 504); return Math.max(1, Math.min(maxMs, remaining)); }
  async stage(name, fn) { const t = this.now(); try { return await fn(); } finally { this.timings[name + '_ms'] = (this.timings[name + '_ms'] || 0) + this.now() - t; } }
  result() { return { ...this.timings, total_ms: this.now() - this.started }; }
}
module.exports = { ACTIONS, READS, normalizeRequest, legacyWrite, requestedValues, OperationDeadline, fail };
