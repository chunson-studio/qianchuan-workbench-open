/* ===== 千川投控 v4 · 共享工具层 ===== */
window.V4 = window.V4 || {};
(function (V4) {
  'use strict';

  // Website-only opt-in. Independent of server/MCP features and each account's browser session.
  const websiteCompass = document.documentElement.dataset.websiteCompass === 'on';
  V4.websiteFeatures = Object.freeze({ compass: websiteCompass });

  // 浏览器禁止持久存储时，本标签页仍能切户和切换主题；刷新后重新选择。
  const memoryPreferences = new Map();
  let persistentStorage = true;
  V4.preferences = {
    get(key) {
      if (persistentStorage) {
        try {
          const value = localStorage.getItem(key);
          if (value === null) memoryPreferences.delete(key);
          else memoryPreferences.set(key, value);
          return value;
        } catch (_) { persistentStorage = false; }
      }
      return memoryPreferences.get(key) ?? null;
    },
    set(key, value) {
      memoryPreferences.set(key, String(value));
      if (persistentStorage) {
        try { localStorage.setItem(key, String(value)); }
        catch (_) { persistentStorage = false; }
      }
    },
  };

  /* ----- 会话级缓存（sessionStorage：刷新保留、关标签页清；隐私模式/超限静默降级） ----- */
  V4.cget = function (key, maxAgeMs) {
    if (key && V4.acct && !key.includes(V4.acct())) console.warn('V4.cget: key 不含当前账号', key);
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || o.ts == null) return null;
      if (maxAgeMs && Date.now() - o.ts > maxAgeMs) return null; // 数据过老不用
      V4.privacy?.capture(o.data);
      return o;
    } catch (e) { return null; }
  };
  V4.cset = function (key, data) {
    if (key && V4.acct && !key.includes(V4.acct())) console.warn('V4.cset: key 不含当前账号', key);
    try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
  };

  /* 平台无时区时间按北京时间解释；ISO 的 Z/offset 必须保留。 */
  V4.parseT = value => {
    const s = String(value || '').trim();
    if (!s) return new Date(NaN);
    const platform = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    return new Date(platform
      ? `${platform[1]}-${platform[2]}-${platform[3]}T${platform[4] || '00'}:${platform[5] || '00'}:${platform[6] || '00'}+08:00`
      : s);
  };
  V4.durTxt = ms => { const m = Math.max(0, Math.floor(ms / 60000)); const h = Math.floor(m / 60); return h ? h + '小时' + V4.p2(m % 60) + '分' : m + '分钟'; };

  /* ----- 基础工具 ----- */
  const $ = id => document.getElementById(id);
  V4.$ = $;
  V4.p2 = n => String(n).padStart(2, '0');
  V4.nowStr = () => { const d = new Date(); return V4.p2(d.getHours()) + ':' + V4.p2(d.getMinutes()) + ':' + V4.p2(d.getSeconds()); };
  /**
   * 将 ISO 时间（UTC）格式化为北京时间 {md, hm, full}。
   * 不依赖 Intl 时区表，直接按 UTC+8 偏移，避免部分环境缺少 Asia/Shanghai 数据。
   */
  V4.fmtCnTime = iso => {
    const s = String(iso || '').trim();
    if (!s) return { md: '--', hm: '--:--', full: '--' };
    const ts = V4.parseT(s).getTime();
    if (!Number.isFinite(ts)) return { md: '--', hm: '--:--', full: '--' };
    const u = new Date(ts + 8 * 3600 * 1000);
    const m = u.getUTCMonth() + 1, day = u.getUTCDate();
    const h = u.getUTCHours(), min = u.getUTCMinutes();
    return {
      md: `${V4.p2(m)}-${V4.p2(day)}`,
      hm: `${V4.p2(h)}:${V4.p2(min)}`,
      full: `${V4.p2(m)}-${V4.p2(day)} ${V4.p2(h)}:${V4.p2(min)}`
    };
  };
  const finite = n => n !== null && n !== undefined && n !== '' && Number.isFinite(+n);
  V4.fmtM = n => finite(n) ? '¥' + Math.round(+n).toLocaleString() : '--';
  V4.fmtM2 = n => finite(n) ? '¥' + (+n).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '--';
  // 金额精确到分：消耗/GMV/成交金额用（千川接口本身到分，整数显示会四舍五入掩盖误差）；大额汇总（余额/预算/配额）仍用 fmtM
  V4.fmtMoney = n => finite(n) ? '¥' + (+n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
  V4.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  V4.RM = matchMedia('(prefers-reduced-motion: reduce)');

  V4.WORD = {top:'未作策略判断',good:'未作策略判断',warn:'未作策略判断',low:'未作策略判断',bad:'未作策略判断',cold:'数据待更新',off:'已下播',uncalibrated:'未作策略判断'};
  const validBreakEven = value => Number.isFinite(+value) && +value > 0;
  V4.hasBreakEven = validBreakEven;
  V4.breakEven = acct => {
    if (!acct && V4.room?.()) return null; // 房间未配置保本线时不继承账号或其他房间。
    const meta = V4.accountMeta && V4.accountMeta(acct);
    return meta && validBreakEven(meta.break_even_roi) ? +meta.break_even_roi : null;
  };
  V4.greenLine = acct => V4.breakEven(acct);
  V4.modeOf = () => 'uncalibrated';
  V4.roiClass = (r, be, acct) => V4.modeOf(r, be, acct);
  /* 状态语义类：统一返回 st-ok / st-warn / st-danger，供新组件直接使用（替代 roiClass 的 top/good/warn/low/bad） */
  V4.stateClass = (r, be) => {
    const c = V4.roiClass(r, be);
    return c === 'top' || c === 'good' ? 'st-ok' : c === 'warn' || c === 'low' ? 'st-warn' : c === 'bad' ? 'st-danger' : '';
  };
  V4.PULSE_COLOR = { top: '#34d399', good: '#34d399', warn: '#fbbf24', low: '#fbbf24', bad: '#f87171', cold: '#6b7280', off: '#6b7280', uncalibrated: '#6b7280' };

  /* ----- 翻牌 ----- */
  V4.flip = function (el, txt) {
    if (!el || el.textContent === txt) return;
    el.textContent = txt; el.classList.remove('flip'); void el.offsetWidth; el.classList.add('flip');
  };

  /* ----- 超长数字自动降字号，防断行（以真实文本为准） ----- */
  V4.fitV = function (el) {
    if (!el) return;
    const n = (el.dataset.odo || el.textContent).length;
    el.classList.toggle('sm', n >= 7 && n < 9);
    el.classList.toggle('xs', n >= 9);
  };

  /* ----- 里程表滚动数字：列内 0-9 两圈；目标位小于当前位时前滚一圈再瞬移归位；
         只滚变化的位，级联从右往左，时长 clamp(80ms×|Δ|, 200, 900) ----- */
  V4.odo = function (el, txt) {
    if (!el) return;
    txt = String(txt);
    const prev = el.dataset.odo;
    if (prev === txt) return;
    el.dataset.odo = txt;
    const still = V4.RM.matches;
    const total = (txt.match(/\d/g) || []).length;
    let cols = el.querySelectorAll('.od-in');
    if (cols.length !== total || el.children.length !== txt.length) {
      let html = '';
      for (const ch of txt) {
        if (/\d/.test(ch)) {
          let spans = ''; for (let k = 0; k < 20; k++) spans += '<span>' + (k % 10) + '</span>';
          html += '<span class="od"><span class="od-in" data-d="">' + spans + '</span></span>';
        } else html += '<span class="od-static">' + V4.esc(ch) + '</span>';
      }
      el.innerHTML = html;
      cols = el.querySelectorAll('.od-in');
    }
    let di = 0;
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      if (!/\d/.test(ch)) continue;
      const col = cols[di]; di++;
      if (col.dataset.d === ch) continue;
      const curD = col.dataset.d === '' ? null : +col.dataset.d;
      col.dataset.d = ch;
      if (still || curD === null) {
        col.style.transition = 'none';
        col.style.transform = 'translateY(-' + (+ch) + 'em)';
        continue;
      }
      let target = +ch, wrap = false;
      if (target < curD) { target += 10; wrap = true; }
      const dist = Math.abs(target - curD);
      col.style.transition = '';
      col.style.transitionDelay = ((total - di) * 30) + 'ms';
      col.style.transitionDuration = Math.min(900, Math.max(200, 80 * dist)) + 'ms';
      col.style.transform = 'translateY(-' + target + 'em)';
      if (wrap) {
        const snap = () => {
          col.removeEventListener('transitionend', snap);
          col.style.transition = 'none';
          col.style.transform = 'translateY(-' + (+ch) + 'em)';
          requestAnimationFrame(() => requestAnimationFrame(() => { col.style.transition = ''; }));
        };
        col.addEventListener('transitionend', snap);
      }
    }
  };

  /* ----- 账号状态（id 以 config.json 为准；从 /api/accounts 动态获取，避免硬编码） ----- */
  const ACCT_KEY = window.QC_DEMO ? 'v4-demo-acct' : 'v4-acct';
  V4.ACCTS = []; // 启动时从 /api/accounts 获取
  V4.features = {};
  V4.setFeatures = features => {
    V4.features = Object.assign({}, features || {});
    document.dispatchEvent(new CustomEvent('v4:features', { detail: V4.features }));
    return V4.features;
  };
  V4.acct = () => {
    const v = V4.preferences.get(ACCT_KEY);
    return V4.ACCTS.some(a => a.id === v) ? v : (V4.ACCTS[0] && V4.ACCTS[0].id) || '';
  };
  V4.acctName = id => (V4.ACCTS.find(a => a.id === (id || V4.acct())) || {}).name || id;
  V4.accountMeta = id => V4.ACCTS.find(a => a.id === (id || V4.acct())) || null;
  const acctListeners = [];
  const accountsListeners = [];
  V4.onAcctChange = fn => acctListeners.push(fn);
  V4.onAccountsChange = fn => accountsListeners.push(fn);
  V4.setAccounts = function (accounts, options) {
    const opts = options || {};
    const previousId = V4.acct();
    const previous = new Map(V4.ACCTS.map(a => [a.id, a]));
    const seen = new Set();
    const next = (Array.isArray(accounts) ? accounts : []).reduce((list, account) => {
      const id = String((account && (account.id || account.accountId)) || '').trim();
      if (!id || seen.has(id)) return list;
      seen.add(id);
      const prior = previous.get(id) || {};
      const source = account || {};
      list.push(Object.assign({}, opts.merge ? prior : {}, source, {
        id,
        name: String(source.name || source.accountName || prior.name || id),
      }));
      return list;
    }, []);
    const changed = JSON.stringify(next) !== JSON.stringify(V4.ACCTS);
    V4.ACCTS = next;
    const currentId = V4.acct();
    if (currentId && currentId !== previousId) {
      V4.preferences.set(ACCT_KEY, currentId);
    }
    if (changed) accountsListeners.forEach(fn => { try { fn(next); } catch (e) { console.error(e); } });
    if (currentId !== previousId) acctListeners.forEach(fn => { try { fn(currentId); } catch (e) { console.error(e); } });
    return next;
  };
  V4.setAcct = id => {
    if (!V4.ACCTS.some(a => a.id === id)) return false;
    if (id === V4.acct()) { V4.preferences.set(ACCT_KEY, id); return true; }
    V4.preferences.set(ACCT_KEY, id);
    acctListeners.forEach(fn => { try { fn(id); } catch (e) { console.error(e); } });
    return true;
  };

  /* 直播上下文与账号选择分开保存：同户房间和同房间换场都不能沿用旧盘面。 */
  const roomLists = new Map(), roomSelections = new Map(), roomListeners = [], roomListListeners = [];
  V4.roomKey = room => room ? JSON.stringify([String(room.roomId), String(room.startTime)]) : '';
  V4.rooms = (account = V4.acct()) => roomLists.get(account) || [];
  V4.room = (account = V4.acct()) => roomSelections.get(account) || null;
  V4.onRoomChange = fn => roomListeners.push(fn);
  V4.onRoomsChange = fn => roomListListeners.push(fn);
  V4.liveScope = () => ({ account: V4.acct(), room_id: V4.room()?.roomId || null, start_time: V4.room()?.startTime || null });
  V4.liveScopeKey = (scope = V4.liveScope()) => JSON.stringify([scope.account, scope.room_id, scope.start_time]);
  function commitRoom(account, room) {
    const previous = V4.roomKey(V4.room(account));
    roomSelections.set(account, room || null);
    try { sessionStorage.setItem('v4-room-' + account, JSON.stringify(room || null)); } catch (e) {}
    if (previous !== V4.roomKey(room)) roomListeners.forEach(fn => fn(account));
  }
  V4.setRoom = (key, account = V4.acct()) => {
    const room = V4.rooms(account).find(item => V4.roomKey(item) === key);
    if (!room) return false;
    commitRoom(account, room);
    return true;
  };
  V4.clearRoom = (account = V4.acct()) => commitRoom(account, null);
  V4.roomsFromWatch = state => {
    if (state?.status_stale === true || state?.cookieExpired === true) return null;
    if (state?.isLive === false && state.status_stale !== true) return [];
    if (state?.available_rooms?.length) return state.available_rooms;
    if (state?.isLive !== true) return null; // 探针未知不撤销已选场次。
    if (state.room) return [state.room];
    if (state.detectedRoomId && state.detectedRoomStartTime) return [{ roomId: state.detectedRoomId, startTime: state.detectedRoomStartTime }];
    return null;
  };
  V4.normalizeRooms = candidates => {
    const seen = new Set();
    return (Array.isArray(candidates) ? candidates : []).reduce((out, raw) => {
      const roomId = String(raw?.roomId ?? raw?.room_id ?? '');
      const startTime = String(raw?.startTime ?? raw?.start_time ?? '');
      if (!roomId || !startTime) return out;
      const room = { ...raw, roomId, startTime, title: raw.title || raw.name || raw.roomName || '' };
      const key = V4.roomKey(room);
      if (!seen.has(key)) { seen.add(key); out.push(room); }
      return out;
    }, []);
  };
  V4.updateRooms = (account, candidates) => {
    if (!V4.ACCTS.some(item => item.id === account)) return;
    const rooms = V4.normalizeRooms(candidates);
    const firstRead = !roomLists.has(account);
    let previous = V4.room(account);
    if (firstRead && !previous) {
      try { previous = JSON.parse(sessionStorage.getItem('v4-room-' + account) || 'null'); } catch (e) {}
    }
    roomLists.set(account, rooms);
    const same = previous && rooms.find(room => V4.roomKey(room) === V4.roomKey(previous));
    // 唯一房间首次接入可直接打开；已选房间下播或换场后必须重新选择。
    commitRoom(account, same || (!previous && firstRead && rooms.length === 1 ? rooms[0] : null));
    roomListListeners.forEach(fn => fn(account));
  };
  const watchStates = new Map(), watchListeners = new Set();
  V4.watchState = (account = V4.acct()) => watchStates.get(account) || null;
  V4.accountLiveView = state => {
    const errors = Array.isArray(state?.errors) ? state.errors : [];
    const hasCode = code => state?.code === code || errors.some(error => error?.code === code);
    const view = (status, label, reason, detail, action = null, actionLabel = null, rooms = null) =>
      ({ state: status, label, rooms, reason, detail, action, actionLabel });
    // 仅明确认证失效才要求更新登录；HTTP 403 不能证明凭据过期。
    if (state?.cookieExpired === true || hasCode('cookie_expired')) return view('credential', '登录已失效', 'cookie_expired',
      '千川返回登录失效，请更新此账户的登录资料后重新核验。', 'credential', '更新登录');
    if (hasCode('cookie_not_found')) return view('credential', '登录资料未配置', 'cookie_not_found',
      '尚未取得此账户的登录资料，请在账户管理中补充。', 'credential', '配置登录');
    const forbidden = hasCode('upstream_forbidden');
    if (!state || state.status_stale === true || typeof state.isLive !== 'boolean') {
      if (forbidden) return view('unknown', '访问被拒绝', 'upstream_forbidden',
        '千川拒绝访问，请核对账户权限或在官方页面验证登录；尚不能确定是否过期。', 'account', '核对账户');
      if (hasCode('rate_limited')) return view('unknown', '请求过于频繁', 'rate_limited',
        '千川暂时限制读取频率，稍后重新核验。', 'refresh', '重新核验');
      if (hasCode('upstream_timeout') || hasCode('queue_timeout')) return view('unknown', '连接超时', 'upstream_timeout',
        '本次未取得直播状态，请稍后重新核验。', 'refresh', '重新核验');
      if (state?.status_stale === true && (typeof state.isLive === 'boolean' || state.liveCheckedAt)) return view('unknown',
        '直播状态更新延迟', 'status_stale', '上次直播状态已超过有效时间，当前是否在播需要重新核验。', 'refresh', '重新核验');
      return view('unknown', '直播状态待核验', 'status_unknown', '尚未取得有效直播状态，请重新核验。', 'refresh', '重新核验');
    }
    if (state.isLive === false) return view('offline', '当前未开播', 'not_live', '本次核验未发现正在直播的房间。', null, null, []);
    const candidates = V4.roomsFromWatch(state), rooms = candidates ? V4.normalizeRooms(candidates) : null;
    if (!rooms?.length) return view('live', '在播 · 房间待核验', 'room_unverified',
      '已确认账户在播，尚未取得完整房间与场次信息。', 'refresh', '重新核验');
    const label = `${rooms.length} 个房间在播`;
    // 某个数据组件失败不推翻独立核验的在播状态，也不清空场次选择。
    if (forbidden) return view('live', label, 'upstream_forbidden',
      '已确认在播，但部分数据访问被拒绝，请核对账户权限或官方页面登录状态。', 'account', '核对账户', rooms);
    if (state.data_stale === true && state.requires_room_selection !== true) return view('live', label + ' · 数据更新延迟',
      'data_stale', '已确认在播，指标尚未更新；请刷新后查看，旧数值不能代表当前表现。', 'refresh', '刷新数据', rooms);
    return view('live', label, 'live', '已取得本次核验的直播间与场次信息。', null, null, rooms);
  };
  V4.updateLiveWatch = (states, replace = false) => {
    if (replace) watchStates.clear();
    for (const state of Array.isArray(states) ? states : []) {
      if (!V4.ACCTS.some(account => account.id === state.accountId)) continue;
      watchStates.set(state.accountId, state);
      const rooms = V4.accountLiveView(state).rooms;
      if (rooms) V4.updateRooms(state.accountId, rooms);
    }
    watchListeners.forEach(fn => fn());
  };
  V4.onLiveWatchChange = fn => { watchListeners.add(fn); return () => watchListeners.delete(fn); };
  V4.loadRooms = async (account = V4.acct()) => {
    let state;
    try {
      const result = await V4.api('/api/live-watch', { account });
      state = result?.accounts?.find(item => item.accountId === account);
      if (!state) throw new Error('未取得当前账号的直播间列表');
    } catch(error) {
      V4.updateLiveWatch([{accountId:account,isLive:null,status_stale:true}]);
      throw error;
    }
    V4.updateLiveWatch([state]);
    const candidates = V4.accountLiveView(state).rooms;
    if (!candidates) throw new Error('直播间状态暂不可用，已保留原选择');
    return V4.rooms(account);
  };
  V4.saveRoomTarget = async (scope, values) => {
    if (!scope?.account || !scope.room_id || !scope.start_time) throw new Error('请先选择直播间');
    const target = Number(values.target_roi);
    const basis = String(values.target_roi_basis || 'unknown');
    if (!Number.isFinite(target) || target <= 0) throw new Error('目标 ROI 必须大于 0');
    if (!['payment', 'platform_net_1h', 'final_settlement', 'chengfang_comprehensive'].includes(basis)) throw new Error('请确认目标 ROI 的口径后再保存');
    await V4.apiPost('/api/config', { account: scope.account, room_id: scope.room_id,
      values: { target_roi: target, target_roi_basis: basis } }, { includeAccount: false });
    const result = await V4.api('/api/config', { account: scope.account, room_id: scope.room_id });
    const params = result?.account_params;
    if (!params || Number(params.target_roi) !== target || params.target_roi_basis !== basis) throw new Error('保存后的目标回读不一致，请重新读取核验');
    return params;
  };

  // 总览与详情使用同一口径投影；缺少同口径实际值时不计算目标差距。
  V4.roiBasisLabels = { payment: '支付 ROI', platform_net_1h: '平台 1 小时净成交 ROI', final_settlement: '最终结算 ROI', chengfang_comprehensive: '乘方综合 ROI', unknown: '口径待确认' };
  V4.roomDashboardMatches = (scope, data) => {
    const room = data?.live?.rooms?.[0];
    return data?.live?.rooms?.length === 1 && data?.account === scope.account && String(room?.roomId ?? room?.room_id ?? '') === String(scope.room_id)
      && String(room?.startTime ?? room?.start_time ?? '') === String(scope.start_time);
  };
  V4.roomTargetView = (data, params = data?.thresholds, now = Date.now()) => {
    const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
    const target = number(params?.target_roi), basis = params?.target_roi_basis || 'unknown';
    const displayBasis = basis === 'unknown' ? 'platform_net_1h' : basis;
    const actual = data?.dataValid === true ? number(displayBasis === 'payment' ? data.today?.roi : displayBasis === 'platform_net_1h' ? data.today?.netRoi : null) : null;
    const core = data?.component_times?.core;
    const sourceAt = (typeof core === 'string' ? core : core?.source_at) || data?.fetchedAt || null;
    const age = sourceAt ? (now - Date.parse(sourceAt)) / 1000 : NaN;
    const fresh = Number.isFinite(age) && age >= -5 && age <= 30 && data?.stale !== true && data?.status_stale !== true && data?.live?.isLive === true;
    const configured = target !== null && target > 0 && ['payment','platform_net_1h','final_settlement','chengfang_comprehensive'].includes(basis);
    const comparable = fresh && actual !== null && configured;
    const delta = comparable ? actual - target : null;
    const state = actual === null || !fresh ? 'unknown' : !comparable ? 'unconfigured' : delta < 0 ? 'below' : 'met';
    const status = state === 'unknown' ? (actual === null ? '数据待核验' : '数据已延迟') : state === 'unconfigured' ? '目标待配置' : state === 'below' ? '低于目标' : '达到目标';
    return { target, basis, displayBasis, actual, sourceAt, age, fresh, configured, comparable, delta, state, status,
      basisLabel: V4.roiBasisLabels[displayBasis] || '口径待确认' };
  };

  /* ----- 写令牌（2026-07-28 修复：手机/局域网访问点执行 401） -----
     非本机写操作需携带 WRITE_API_TOKEN：URL 带 ?token=xxx 打开一次即存入本地并清出地址栏；
     apiPost 自动带 x-api-token 头。书签保存带 token 的链接可长期使用。 */
  const TOKEN_KEY = 'v4_write_token';
  try {
    const urlq = new URLSearchParams(location.search);
    const tk = urlq.get('token');
    if (tk && !window.QC_DEMO) {
      V4.preferences.set(TOKEN_KEY, tk);
      urlq.delete('token');
      history.replaceState(null, '', location.pathname + (urlq.toString() ? '?' + urlq.toString() : '') + location.hash);
    }
  } catch (e) { /* localStorage 不可用时不阻断页面 */ }

  /* ----- API（默认 60s 超时，挂死请求自动中断，防轮询堆积） ----- */
  const timeoutBudget = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 60000;
  function clientTimeout(ms) {
    return Object.assign(new Error(`请求超时（${Math.round(ms / 1000)} 秒），本轮已停止等待`), {
      name: 'ClientTimeoutError', code: 'client_timeout', component: 'browser_client', retryable: true, timeout_ms: ms,
    });
  }
  function retryDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(signal.reason || Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
      const timer = setTimeout(() => finish(), ms);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  V4.api = async function (path, params, opts) {
    const pathname = new URL(path, location.origin).pathname;
    if (!websiteCompass && /^\/(?:api\/compass|compass_api)(?:\/|$)/.test(pathname)) {
      throw Object.assign(new Error('网站罗盘数据已关闭'), { code: 'website_compass_disabled' });
    }
    const q = new URLSearchParams(params || {});
    const baseOptions = Object.assign({}, opts || {});
    if (!baseOptions.skipAccountParam && !q.has('account') && !q.has('accountId')) q.set('account', V4.acct());
    const url = path + (q.toString() ? '?' + q.toString() : '');
    // 只对瞬时网络错误重试一次。超时代表本轮预算已耗尽，立即显式失败；
    // 不复用上一轮的 AbortSignal，否则计时器清理后可能留下一个再也不会中断的请求。
    let lastErr;
    const method = String(baseOptions.method || 'GET').toUpperCase();
    // 写请求断网时可能已被服务端接受；不能自动重发，交给操作回执/只读查询确认。
    const canRetryRead = method === 'GET' || method === 'HEAD';
    const attempts = canRetryRead && baseOptions.retryNetwork !== false ? 2 : 1;
    const budget = timeoutBudget(baseOptions.timeout), deadline = Date.now() + budget;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (baseOptions.signal?.aborted) throw baseOptions.signal.reason || Object.assign(new Error('请求已取消'), { name: 'AbortError' });
      // 退避和重试共用本轮期限，不能把一次读取扩成两个完整超时周期。
      if (attempt) await retryDelay(Math.max(0, Math.min(1500 * attempt, deadline - Date.now())), baseOptions.signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw clientTimeout(budget);
      try { return await apiOnce(url, Object.assign({}, baseOptions, { timeout: remaining })); }
      catch (e) {
        if (e?.code === 'client_timeout') throw clientTimeout(budget);
        lastErr = e;
        if (baseOptions.signal?.aborted || !(e instanceof TypeError) || attempt + 1 >= attempts) throw e;
      }
    }
    throw lastErr;
  };
  async function apiOnce(url, o) {
    const options = Object.assign({}, o || {});
    const ms = timeoutBudget(options.timeout);
    delete options.timeout;
    delete options.retryNetwork;
    delete options.skipAccountParam;
    const callerSignal = options.signal;
    const ctl = new AbortController();
    let timedOut = false;
    const cancel = () => ctl.abort(callerSignal.reason);
    if (callerSignal?.aborted) cancel();
    else callerSignal?.addEventListener('abort', cancel, { once: true });
    options.signal = ctl.signal;
    const t = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    try {
      const r = await fetch(url, options);
      let j = null;
      try { j = await r.json(); }
      catch (e) {
        // 响应头先到、正文超时也必须显式失败，不能吞掉取消后返回空数据。
        if (ctl.signal.aborted) throw e;
        if (r.ok && r.status !== 204 && String(options.method || 'GET').toUpperCase() !== 'HEAD') {
          const error = new Error('服务响应格式异常，请稍后重试');
          Object.assign(error, { code: 'invalid_response', component: 'http_api', status: r.status, retryable: true });
          throw error;
        }
      }
      if (ctl.signal.aborted) throw ctl.signal.reason || Object.assign(new Error('请求已取消'), { name: 'AbortError' });
      V4.privacy?.capture(j);
      if (!r.ok || (j && j.ok === false)) {
        const err = new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
        err.status = r.status;
        err.body = j;
        err.code = j && j.code || (r.ok ? 'api_error' : `http_${r.status}`);
        err.component = j && j.component || 'http_api';
        err.retryable = !!(j && j.retryable);
        throw err;
      }
      return j;
    } catch (e) {
      if (timedOut) {
        throw clientTimeout(ms);
      }
      throw e;
    } finally {
      if (t) clearTimeout(t);
      callerSignal?.removeEventListener('abort', cancel);
    }
  }
  V4.apiJson = function (path, method, body, opts) {
    const options = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const wtk = window.QC_DEMO ? null : V4.preferences.get(TOKEN_KEY);
    if (wtk) headers['x-api-token'] = wtk;
    const includeAccount = options.includeAccount !== false;
    const payload = includeAccount ? Object.assign({ accountId: V4.acct() }, body || {}) : (body || {});
    const requestOptions = Object.assign({}, options, {
      method,
      headers,
      body: JSON.stringify(payload),
      skipAccountParam: !includeAccount,
    });
    delete requestOptions.includeAccount;
    return V4.api(path, null, requestOptions);
  };
  V4.apiPost = function (path, body, opts) {
    return V4.apiJson(path, 'POST', body, opts);
  };

  // 顶栏和总览共用同一次在途状态读取；完成即释放，不延长数据新鲜度。
  let liveWatchFlight = null;
  V4.loadLiveWatch = function () {
    if (!liveWatchFlight) liveWatchFlight = V4.api('/api/live-watch', { accountId: '' }, { timeout: 25000 })
      .finally(() => { liveWatchFlight = null; });
    return liveWatchFlight;
  };

  // 账号表是前端唯一的账号来源：配置增删账号后，刷新页面即可同步；接口失败时不伪造旧账号。
  let accountsLoadPromise = null;
  V4.accountsReady = false;
  V4.loadAccounts = function () {
    if (accountsLoadPromise) return accountsLoadPromise;
    accountsLoadPromise = (async () => {
      try {
        const j = await apiOnce('/api/accounts', { timeout: 10000 });
        if (!j || !j.ok || !Array.isArray(j.accounts)) throw new Error((j && j.error) || '账号列表格式错误');
        V4.accountsError = null;
        V4.accountsReady = true;
        V4.archivedAccounts = Array.isArray(j.archived_accounts) ? j.archived_accounts : [];
        V4.setFeatures(j.ui_features);
        return V4.setAccounts(j.accounts);
      } catch (e) {
        V4.accountsError = (e && e.message) || '账号列表加载失败';
        console.error('[v4] 获取账号列表失败:', e);
        return V4.ACCTS;
      }
    })();
    return accountsLoadPromise;
  };
  V4.retryAccounts = function () { accountsLoadPromise = null; return V4.loadAccounts(); };
  V4.loadAccounts();

  /* ----- 轮询（等本轮结束再计时；隐藏时不发起请求，回前台最多补一轮） ----- */
  V4.poll = function (fn, ms) {
    let timer = null, stopped = false, running = false;
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const schedule = () => {
      if (stopped || document.hidden) return;
      const delay = Number(typeof ms === 'function' ? ms() : ms);
      timer = setTimeout(run, Number.isFinite(delay) && delay > 0 ? delay : 60000);
    };
    const run = async () => {
      clear();
      if (stopped || document.hidden || running) return;
      running = true;
      try { await fn(); }
      catch (error) { console.error('[v4] 本轮刷新失败', error); }
      finally { running = false; schedule(); }
    };
    const onVis = () => { clear(); if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVis);
    run();
    const stop = () => { stopped = true; clear(); document.removeEventListener('visibilitychange', onVis); };
    stop.refresh = run; // 子面板切换复用同一个在途锁，不另起一条刷新链。
    return stop;
  };

  /* ----- 粒子背景（余光状态层；减弱动效只画一帧） ----- */
  V4.initPulse = function (canvasId) {
    const pc = $(canvasId); if (!pc || document.documentElement?.dataset.uiEffects === 'minimal') return { setMode() {} };
    const px = pc.getContext('2d');
    let W, H, ps = [], mode = 'good';
    const cur = { r: 52, g: 211, b: 153 };
    const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
    function rs() {
      W = pc.width = innerWidth; H = pc.height = innerHeight;
      ps = Array.from({ length: 64 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5), vy: (Math.random() - .5), r: .8 + Math.random() * 1.4 }));
    }
    function frame(moving) {
      const t = hex(V4.PULSE_COLOR[mode] || V4.PULSE_COLOR.good);
      cur.r += (t.r - cur.r) * .03; cur.g += (t.g - cur.g) * .03; cur.b += (t.b - cur.b) * .03;
      const col = `rgba(${cur.r | 0},${cur.g | 0},${cur.b | 0}`;
      const sp = !moving ? 0 : (mode === 'off' ? .05 : (mode === 'good' || mode === 'top') ? .3 : mode === 'warn' ? .7 : 1.6);
      px.clearRect(0, 0, W, H);
      for (const p of ps) {
        p.x += p.vx * sp; p.y += p.vy * sp;
        if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20; if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
        px.beginPath(); px.arc(p.x, p.y, p.r, 0, 7); px.fillStyle = col + ',.45)'; px.fill();
      }
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j], d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (d < 11000) { px.beginPath(); px.moveTo(a.x, a.y); px.lineTo(b.x, b.y); px.strokeStyle = col + `,${(1 - d / 11000) * .12})`; px.lineWidth = .55; px.stroke(); }
      }
    }
    rs();
    addEventListener('resize', () => { rs(); if (V4.RM.matches) frame(false); });
    if (V4.RM.matches) frame(false);
    else (function loop() { if (!document.hidden) frame(true); requestAnimationFrame(loop); })();
    return {
      setMode(m) { mode = m; if (V4.RM.matches) frame(false); },
    };
  };

  /* ----- 空态 / 错误态 ----- */
  V4.emptyBox = t => `<div class="empty">${V4.esc(t)}</div>`;
  V4.errBox = e => {
    const expired = e && [e.code, e.message, e.body && e.body.code, e.body && e.body.error].includes('cookie_expired');
    const msg = expired ? '账户登录已过期，请更新登录后重试' : (e && e.status === 401)
      ? '访问验证失败，请检查工作台访问令牌'
      : ('加载失败：' + ((e && e.message) || e));
    const action = expired ? ' <a href="#/onboarding">更新账户登录</a>' : '';
    return `<div class="err-box"><span class="signal-dot warn"></span> ${V4.esc(msg)}${action}</div>`;
  };

  /* ----- 顶条「更新于」 ----- */
  V4.touch = () => { const u = $('upd'); if (u) u.textContent = '更新于 ' + V4.nowStr(); };

})(window.V4);

/* ===== 主题切换（暗夜 ⇄ 纸张卡通，localStorage v4-theme 持久化） ===== */
(function (V4) {
  'use strict';
  const KEY = 'v4-theme';

  function apply(theme) {
    if (theme === 'paper') document.documentElement.setAttribute('data-theme', 'paper');
    else document.documentElement.removeAttribute('data-theme');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'paper' ? '纸张主题' : '暗夜主题';
  }

  V4.theme = () => V4.preferences.get(KEY) || 'paper';
  V4.toggleTheme = function () {
    const next = V4.theme() === 'paper' ? 'dark' : 'paper';
    V4.preferences.set(KEY, next);
    apply(next);
  };

  function init() {
    apply(V4.theme());
    const btn = document.getElementById('themeToggle');
    if (btn) btn.onclick = V4.toggleTheme;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window.V4);

/* ===== 部署检测 + 全局异常可视化（2026-07-30） =====
   背景：维护者标签页连开多天，服务端已部署新版，内存旧 JS 异常导致按钮"点击无反应"。
   ① 每 5 分钟比对 /api/version，不一致顶部横幅提示刷新；② window 错误/未捕获 Promise 显性提示。
   都只提示一次、点击横幅即刷新，不自动强刷（不打断未读决策流）。 */
(function (V4) {
  'use strict';

  function showBanner(text, title) {
    if (document.getElementById('v4StaleBanner')) return; // 只插一次
    const b = document.createElement('div');
    b.id = 'v4StaleBanner';
    b.textContent = text;
    if (title) b.title = title;
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px 14px;text-align:center;font-size:13px;cursor:pointer;background:var(--st-warn,#e6a23c);color:#1a1a1a;font-weight:600';
    b.onclick = () => location.reload();
    document.body.appendChild(b);
  }

  /* ① 部署版本检测：页面可见时才轮询（对齐 V4.poll 后台停表纪律） */
  V4._ver = null;
  async function checkVer() {
    try {
      const j = await V4.api('/api/version', null, { skipAccountParam: true, cache: 'no-store', timeout: 10000, retryNetwork: false });
      if (!j || !j.ok || !j.v) return;
      if (!V4._ver) { V4._ver = j.v; return; } // 首次只记录
      if (j.v !== V4._ver) showBanner('系统已更新，点击刷新获取新版');
    } catch (e) { /* 网络失败静默，下轮再试 */ }
  }
  checkVer();
  setInterval(() => { if (!document.hidden) checkVer(); }, 5 * 60 * 1000);

  /* ② 全局异常可视化：静默死按钮 → 显性"请刷新" */
  function onErr(msg) {
    showBanner('页面脚本异常，点击刷新（Ctrl+F5）', String(msg || '').slice(0, 200));
  }
  window.addEventListener('error', e => onErr(e.message || (e.error && e.error.message)));
  window.addEventListener('unhandledrejection', e => onErr(e.reason && (e.reason.message || e.reason)));
})(window.V4);
