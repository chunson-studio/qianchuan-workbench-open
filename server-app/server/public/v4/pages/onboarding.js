/* 本机接入向导：浏览器登录由 Codex 接续；不提供手动 Cookie 导入。 */
(function (V4) {
  'use strict';
  const esc = V4.esc;
  const labels = { payment: '支付 ROI', platform_net_1h: '平台 1 小时净成交 ROI', final_settlement: '最终结算 ROI',
    agent_decides: '由 Agent 决策', chengfang_comprehensive: '乘方综合 ROI', unknown: '暂不清楚', recommendation_only: '只读建议', confirm_writes: '每次确认后操作（记录意向）',
    auto_guarded: '授权内自主操作（记录意向）', important_only: '重要变化与异常', every_round: '每轮汇报',
    plan_roi: '主计划 ROI', plan_budget: '主计划预算', boost_create: '新建追投', boost_update: '追投调参', boost_pause: '暂停追投',
    boost_resume: '恢复追投', boost_delete: '删除追投', flow_control: '一键控量', volume_start: '一键起量', material_remove: '移出素材' };
  const show = value => value == null ? '暂不清楚' : esc(labels[value] || String(value));
  let mounted = null;
  V4.onAcctChange?.(() => mounted?.accountChanged());
  V4.pages.onboarding = {
    mount(root) {
      let disposed = false, state = null, landing = null, selected = null, busy = false;
      let generation = 0, operationGeneration = 0, publishingAccount = false, refreshAfterBusy = false;
      const currentStep = () => !disposed && operationGeneration === generation;
      function publishAccount(work) {
        publishingAccount = true;
        try { work(); } finally { publishingAccount = false; }
      }
      root.innerHTML = `<style>
      .onboard{max-width:880px;margin:20px auto;color:var(--ink);font-size:16px;line-height:1.7}
      .onboard h1{font-size:28px;margin-bottom:8px}.onboard h2{font-size:20px;margin:0 0 12px}
      .onboard .ob-card{border:1px solid var(--line);background:var(--panel);border-radius:16px;padding:24px;margin:20px 0}
      .onboard p{margin:8px 0 16px}.onboard label{display:block;margin:16px 0 6px}
      .onboard input:not([type=checkbox]),.onboard select,.onboard textarea{display:block;width:100%;padding:10px;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;box-sizing:border-box}
      .onboard select option{color:var(--ink);background:var(--bg)}.onboard fieldset{border:1px solid var(--line);border-radius:8px;margin:14px 0}
      .onboard .ob-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.onboard button,.onboard .ob-link{padding:10px 16px;min-height:44px;border-radius:8px;border:1px solid var(--line);font:inherit;background:var(--panel);color:var(--ink);cursor:pointer}
      .onboard button.primary{background:#175cd3;color:white;border-color:#175cd3}.onboard button:disabled{opacity:.55;cursor:wait}
      .onboard .ob-muted{color:var(--ink-2);font-size:14px}.onboard .ob-message{white-space:pre-wrap;overflow-wrap:anywhere}
      .onboard .ob-warning{border-left:3px solid #d98a13;padding:8px 14px}.onboard .ob-steps{margin:0 0 16px;padding:12px 16px;background:var(--bg);border-radius:8px}.onboard .ob-steps strong{display:block}.onboard .ob-steps ol{margin:4px 0 0 20px;padding:0}.onboard dl{display:grid;grid-template-columns:minmax(100px,1fr) 2fr;gap:8px;margin:0}.onboard dd{margin:0;overflow-wrap:anywhere}
      @media(max-width:600px){.onboard{margin:8px}.onboard .ob-card{padding:16px}.onboard dl{display:block}.onboard dd{margin-bottom:12px}}
      </style><section class="onboard"><header class="onboard-intro"><span class="onboard-kicker">开始使用</span><h1>连接账户，看清每一场投放</h1><p>先接入千川，查看消耗、成交与投产。经营目标可以稍后补充。</p></header><ol class="onboard-progress" aria-label="接入步骤"><li data-ob-step="1" aria-current="step"><span>1</span>连接千川</li><li data-ob-step="2"><span>2</span>核对账户</li><li data-ob-step="3"><span>3</span>进入工作台</li></ol><div class="ob-message" role="status" aria-live="polite">正在检查已有配置…</div><div class="ob-content"></div></section>`;
      const host = root.querySelector('.ob-content'), message = root.querySelector('.ob-message');
      function step(number) {
        root.querySelectorAll('[data-ob-step]').forEach(node => {
          const value = Number(node.dataset.obStep);
          node.classList.toggle('complete', value < number);
          if (value === number) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
        });
      }
      const api = (body, id) => body
        ? V4.apiJson('/api/onboarding', 'POST', body, { includeAccount: false, headers: { 'x-qc-onboarding': '1' }, timeout: 60000 })
        : V4.api('/api/onboarding', id ? { account_id: id } : {}, { skipAccountParam: true, timeout: 12000 });
      async function run(work) {
        if (disposed || busy) return;
        operationGeneration = generation;
        let focusAfter = null;
        busy = true; host.querySelectorAll('button,input,select,textarea').forEach(control => control.disabled = true);
        message.textContent = '正在处理，请稍候。只读验证可能需要几十秒…';
        try { await work(); if (currentStep()) message.textContent = ''; }
        catch (e) {
          if (currentStep()) {
            message.textContent = e.message || '操作未完成，可重试；已保存的进度仍保留。';
            if (e.code === 'account_selection_required') {
              const extra = host.querySelector('#ob-account-help');
              if (extra) { extra.open = true; focusAfter = host.querySelector('#ob-advertiser'); }
            }
          }
        }
        finally {
          busy = false;
          if (!disposed) {
            host.querySelectorAll('button,input,select,textarea').forEach(control => control.disabled = false);
            if (currentStep()) focusAfter?.focus();
            if (refreshAfterBusy) { refreshAfterBusy = false; void run(loadLanding); }
          }
        }
      }
      function field(q) {
        const value = state.answers[q.key];
        if (q.type === 'actions') return `<details><summary>${esc(q.label)}（可选，已选 ${(value || []).length} 项）</summary><fieldset data-actions="${q.key}"><legend>${esc(q.label)}</legend>${q.options.map(key => `<label><input type="checkbox" value="${key}" ${(value || []).includes(key) ? 'checked' : ''}> ${show(key)}</label>`).join('')}</fieldset></details>`;
        if (q.type === 'select') return `<label for="ob-${q.key}">${esc(q.label)}</label><select id="ob-${q.key}" name="${q.key}">${q.options.map(key => `<option value="${key}" ${value === key || (value == null && ['unknown', 'recommendation_only', 'important_only'].includes(key)) ? 'selected' : ''}>${show(key)}</option>`).join('')}</select>`;
        return `<label for="ob-${q.key}">${esc(q.label)}</label><input id="ob-${q.key}" name="${q.key}" type="${q.type === 'number' ? 'number' : 'text'}" ${q.type === 'number' ? 'min="0" step="any"' : 'maxlength="500"'} value="${esc(value ?? '')}">`;
      }
      function renderState() {
        if (!currentStep()) return;
        step(2);
        const current = state.platform_current;
        const questions = state.next_questions;
        host.innerHTML = `<div class="ob-card"><div class="ob-steps"><strong>第 2 步：确认账户与主计划</strong><ol><li>先做一次只读预演，读取账户和计划。</li><li>如有多个计划，只选择你确认过的主计划。</li></ol></div><h2>${esc(state.account.name)}</h2><p class="ob-muted">账户已接入。当前操作决策方式：${show(state.existing_execution_mode)}。</p><p class="ob-warning">保存账户资料和经营偏好后，Agent 根据你的指令决定具体操作。</p>
          <div class="ob-actions"><button data-do="read">读取账户与计划 · 只读预演</button><button data-do="credential">登录与接续说明</button><button data-do="home">换一个账户</button></div>
          ${state.observations ? `<p class="ob-muted">读取时间：${esc(state.observations.checked_at)} · ${state.observations_fresh ? '十分钟内' : '需重新验证'}</p>
          <label for="ob-plan">主计划（只从本账户真实列表选择）</label><select id="ob-plan"><option value="">暂不选择</option>${state.observations.plans.map(p => `<option data-private="mixed" value="${esc(p.id)}" ${p.id === state.primary_ad_id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.id)}</option>`).join('')}</select>
          <div class="ob-actions"><button data-do="plan">确认计划选择</button></div>
          <p>平台当前设置：ROI ${show(current?.roi_goal)}（${show(current?.roi_basis || 'unknown')}） · 预算 ${show(current?.budget)} 元 · 余额 ${show(state.observations.balance.available_yuan)} 元</p>
          ${state.observations.plan_conflict ? '<p class="ob-warning">原主计划未在这次列表中核验成功，不会擅自替换。可先保存已确认的账户资料。</p>' : ''}` : '<p>先读取当前设置；经营目标与财务保本线会单独询问。</p>'}
          </div>
          ${questions.length ? `<form class="ob-card" id="ob-form"><div class="ob-steps"><strong>第 3 步：补充配置</strong><span>这一组保存后会继续显示下一组；不确定的数值可以留空。</span></div><h2>补齐这一组信息</h2>${questions.map(field).join('')}
          ${questions.some(q => q.key === 'mode') ? '<p class="ob-warning">操作偏好供 Agent 决策参考。</p>' : ''}
          <div class="ob-actions"><button class="primary" type="submit">保存这一步，继续</button></div></form>` : ''}
          <div class="ob-card"><div class="ob-steps"><strong>第 4 步：核对并保存</strong><span>先完成只读预演，再确认保存。</span></div><h2>配置预览</h2><dl>${state.questions.filter(q => state.answered.includes(q.key)).map(q => `<dt>${esc(q.label)}</dt><dd>${Array.isArray(state.answers[q.key]) ? state.answers[q.key].map(show).join('、') || '无' : show(state.answers[q.key])}</dd>`).join('')}</dl>
          <p class="ob-warning">${esc(state.authorization.explanation)}</p>
          <p>未知 ROI、暂无主计划或无历史数据都可以先保存，Agent 按任务需要补充。保存账户资料不会调整平台计划。</p>
          <label><input id="ob-confirm" type="checkbox"> 我已核对账户、主计划与经营资料，确认保存</label>
          <div class="ob-actions"><button class="primary" data-do="save">核验账户并保存</button><button data-do="edit">重新编辑已填信息</button></div></div>`;
        host.querySelector('[data-do=read]').onclick = () => run(async () => { state = await api({ action: 'rehearse', account_id: selected }); renderState(); });
        host.querySelector('[data-do=home]').onclick = () => run(loadLanding);
        host.querySelector('[data-do=credential]').onclick = () => renderImport(true);
        host.querySelector('[data-do=plan]')?.addEventListener('click', () => run(async () => {
          state = await api({ action: 'draft', account_id: selected, revision: state.revision, primary_ad_id: host.querySelector('#ob-plan').value || null }); renderState();
        }));
        host.querySelector('#ob-form')?.addEventListener('submit', event => {
          event.preventDefault(); const answers = {};
          for (const q of questions) answers[q.key] = q.type === 'actions'
            ? [...host.querySelectorAll(`[data-actions=${q.key}] input:checked`)].map(i => i.value)
            : q.type === 'number' ? (host.querySelector(`[name=${q.key}]`).value === '' ? null : Number(host.querySelector(`[name=${q.key}]`).value))
            : host.querySelector(`[name=${q.key}]`).value;
          run(async () => { state = await api({ action: 'draft', account_id: selected, revision: state.revision, answers }); renderState(); });
        });
        host.querySelector('[data-do=edit]').onclick = () => { state.next_questions = state.questions; renderState(); };
        host.querySelector('[data-do=save]').onclick = () => {
          if (!host.querySelector('#ob-confirm').checked) { message.textContent = '请先勾选确认；不会自动替你授权。'; return; }
          run(async () => {
            state = await api({ action: 'rehearse', account_id: selected });
            if (!currentStep()) return;
            state = await api({ action: 'save', account_id: selected, revision: state.revision, confirm: true });
            if (currentStep()) { renderState(); host.insertAdjacentHTML('afterbegin', '<div class="ob-card"><h2>账户接入已完成</h2><p>可以让 Agent 读取数据、分析盘面并调用操作工具；具体任务按你的指令执行。</p><a class="ob-link" href="#/overview">回到工作台</a></div>'); }
          });
        };
      }
      function renderConnections() {
        if (!currentStep()) return;
        step(3);
        host.innerHTML = `<div class="ob-card ob-connected"><span class="ob-connected-label">账户已连接</span><h2>${esc(state.account.name)}</h2><p>已有账户资料继续沿用。登录失效时，在对应浏览器完成登录，再由 Codex 核验并接续。</p><div class="ob-actions"><a class="ob-link primary" href="#/overview">进入工作台 →</a><button data-qc>登录与接续说明</button></div></div>
          ${V4.websiteFeatures.compass ? '<div class="ob-card"><h2>罗盘数据</h2><p>需要罗盘数据时，在本场浏览器登录同一店铺的罗盘，由 Codex 核对直播间和场次后读取。千川与罗盘登录态分别核验。</p><a class="ob-link" href="https://compass.jinritemai.com/" target="_blank" rel="noopener noreferrer">打开罗盘</a></div>' : ''}
          <div class="ob-actions"><button data-advanced>设置目标、预算与主计划</button><button data-switch>切换 / 添加账户</button></div>`;
        host.querySelector('[data-qc]').onclick = () => renderImport(true);
        host.querySelector('[data-advanced]').onclick = renderState;
        host.querySelector('[data-switch]').onclick = () => run(() => loadLanding(true));
      }
      async function choose(id) {
        if (!currentStep()) return;
        const next = await api(null, id);
        if (!currentStep()) return;
        selected = id; state = next;
        publishAccount(() => V4.setAcct(id));
        renderConnections();
      }
      function renderImport(updating = false) {
        if (disposed) return;
        step(1);
        host.innerHTML = `<div class="ob-card"><div class="ob-steps"><strong>浏览器登录与接续</strong></div><h2>${updating ? '接续所选账户' : '连接千川账户'}</h2><ol><li>在 Codex 使用的本场浏览器打开千川，本人完成登录并选择目标广告账户。</li><li>告诉 Codex 要接续的账户与直播间，由 Codex 核验账户、主计划和本场对象。</li><li>已有账户需要更新本机凭据时，由 Codex 使用已验证脚本处理；首次新增账户由 Codex 核验接入能力和待补资料。</li></ol><p>无需安装 Cookie Editor、导出文件或粘贴 JSON。此页面不自动读取浏览器登录态；登录成功与本机账户接入分别核验。</p><div class="ob-actions"><a class="ob-link" href="${esc(landing.login_url)}" target="_blank" rel="noopener noreferrer">打开千川登录</a><button data-back>返回</button></div></div>`;
        host.querySelector('[data-back]').onclick = () => run(loadLanding);
      }
      async function loadLanding(showAccounts = false) {
        if (!currentStep()) return;
        if (window.QC_DEMO) {
          step(3);
          host.innerHTML = '<div class="ob-card ob-connected"><span class="ob-connected-label">示例体验</span><h2>把工作台换成你的数据</h2><p>示例展示的是本地虚构数据。退出示例后，按步骤连接自己的千川账户，即可使用同样的房间总览和场次页面。</p><div class="ob-actions"><a class="ob-link primary" href="/v4#/onboarding">连接我的账户 →</a><a class="ob-link" href="#/overview">继续看示例</a></div></div>';
          return;
        }
        landing = await api(); if (!currentStep()) return;
        if (!showAccounts && landing.accounts.length) { await choose(landing.accounts.find(a => a.id === V4.acct())?.id || landing.accounts[0].id); return; }
        selected = null;
        step(1);
        if (landing.first_use) {
          host.innerHTML = `<div class="onboard-welcome"><div class="ob-card ob-start"><span class="onboard-kicker">为直播投手与运营团队准备</span><h2>把分散的数据，放到一个工作台</h2><p>按账户和直播间查看经营数据，记录每次判断，回看一整场的变化。</p><ul class="ob-benefits"><li><span>01</span><div><strong>先找到需要关注的房间</strong><small>把消耗、净成交与各自的 ROI 目标放在一起看。</small></div></li><li><span>02</span><div><strong>从数据走到下一步</strong><small>查看本场追投与决策记录，操作结果可回读。</small></div></li><li><span>03</span><div><strong>保留自己的经营记录</strong><small>账户资料和接续状态保存在本机，按场次复盘。</small></div></li></ul><div class="ob-actions"><button class="primary" data-new>连接我的千川账户 →</button><a class="ob-link" href="/v4?demo=1#/overview">先看示例</a></div><p class="ob-muted ob-start-note">只需先连接千川。没有目标或预算资料，也可以开始。</p></div><aside class="ob-card ob-preview" aria-label="功能预览"><div class="ob-preview-heading"><span><i></i>直播间总览</span><small>界面示意</small></div><div class="ob-preview-room"><span class="ob-preview-avatar" aria-hidden="true">直</span><div><strong>品牌直播间</strong><small>本场关键指标</small></div><b>查看场次 ↗</b></div><div class="ob-preview-metrics"><div><small>本场消耗</small><strong>¥1,280.60</strong></div><div><small>净 ROI</small><strong>6.42</strong></div><div><small>净成交</small><strong>¥8,221.45</strong></div><div><small>净订单</small><strong>108</strong></div></div><div class="ob-preview-bars" aria-hidden="true">${[30,42,36,58,51,66,60,82,73,90,84,100].map(h=>`<i style="--bar-height:${h}%"></i>`).join('')}</div><p>每个房间，使用自己的目标与数据口径。</p><span class="ob-preview-note">虚构数据，仅用于展示界面</span></aside></div>`;
          host.querySelector('[data-new]').onclick = () => renderImport();
          return;
        }
        host.innerHTML = `<div class="ob-card"><div class="ob-steps">${landing.first_use ? '<strong>你现在只需要能登录自己的千川账户</strong><p>点击下方按钮，跟着提示连接账户。目标和预算稍后再问，不清楚的可以先跳过。</p>' : '<strong>你的接入进度已保存</strong><p>选择账户后可查看配置与浏览器接续说明，无需重填经营问卷。</p>'}</div><h2>${landing.first_use ? '欢迎，先连接千川账户' : '管理数据接入'}</h2>
        ${landing.accounts.length ? `<label for="ob-account">已有账户</label><select id="ob-account">${landing.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><div class="ob-actions"><button class="primary" data-continue>管理账户连接</button></div>` : ''}
        <div class="ob-actions"><button data-new>${landing.first_use ? '开始连接千川账户' : '连接另一个账户'}</button></div><p class="ob-muted">在本场浏览器登录，由 Codex 核验并接续；不需要手动导出登录文件。遇到问题时按页面提示继续，已保存的进度会保留。</p></div>`;
        host.querySelector('[data-new]').onclick = () => renderImport();
        host.querySelector('[data-continue]')?.addEventListener('click', () => run(() => choose(host.querySelector('#ob-account').value)));
      }
      const controller = { accountChanged() {
        if (disposed || publishingAccount) return;
        generation++;
        message.textContent = '账户已切换，正在读取当前账户…';
        if (busy) refreshAfterBusy = true; else void run(loadLanding);
      } };
      mounted = controller;
      run(loadLanding);
      return () => { disposed = true; if (mounted === controller) mounted = null; root.innerHTML = ''; };
    },
  };
})(window.V4);
