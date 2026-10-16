// In-memory UI only: no browser launch, sockets, credentials, files or schedules.
// Locator calls resolve current state; evaluateAll runs the production callback
// against row-shaped DOM objects rather than returning precomputed task results.
export const fakeBinding = Object.freeze({
  advertiser_id: '60000000', primary_ad_id: '60000028',
  room_id: '60000029', date: '2026-10-06',
});
export const ALL = '全部（包括已删除）';
export const HEADERS = Object.freeze([
  '任务名称', '调控状态', '调控消耗', '调控成交订单数',
  '调控支付ROI', '调控预算', '调控时长(小时)',
]);
export function fakeTask(id = '60000042', overrides = {}) {
  return { id, name: 'fixture task', status: '调控中', cost: '12.90',
    orders: '0', roi: '3.02', budget: '100', hours: '5\n预计 明天结束', ...overrides };
}
const matches = (actual, expected, exact = false) => expected instanceof RegExp
  ? new RegExp(expected.source, expected.flags).test(actual)
  : exact ? actual === expected : actual.includes(expected);
const flatten = nodes => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
const textOf = node => node.text ?? node.name ?? '';
const describe = node => ({ role: node.role, name: node.name, id: node.task?.id });

class Locator {
  constructor(model, resolve) { this.model = model; this.resolve = resolve; }
  filter(options) {
    if (Object.keys(options).some(k => !['hasText', 'visible'].includes(k))) throw Error('Unsupported fake filter');
    return new Locator(this.model, () => this.resolve().filter(n =>
      (options.hasText === undefined || matches(textOf(n), options.hasText)) &&
      (options.visible === undefined || (n.visible !== false) === options.visible)));
  }
  nth(index) { return new Locator(this.model, () => this.resolve().slice(index, index + 1)); }
  getByRole(role, options = {}) {
    return new Locator(this.model, () => flatten(this.resolve().flatMap(n => n.children ?? []))
      .filter(n => n.role === role && (options.name === undefined || matches(n.name ?? '', options.name, options.exact))));
  }
  getByText(text, options = {}) {
    return new Locator(this.model, () => flatten(this.resolve().flatMap(n => n.children ?? []))
      .filter(n => matches(textOf(n), text, options.exact)));
  }
  async count() { return this.resolve().length; }
  unique() {
    const nodes = this.resolve();
    if (nodes.length !== 1) throw Error(`fake strict locator: expected 1, got ${nodes.length}`);
    return nodes[0];
  }
  async isVisible() { return this.unique().visible !== false; }
  async click() {
    const n = this.unique();
    await this.model.event('click', describe(n), () => this.model.click(n));
  }
  async uncheck() {
    const n=this.unique();
    if(n.role!=='checkbox')throw Error('Unsupported fake uncheck');
    await this.model.event('uncheck',describe(n),()=>{this.model.selected.delete(n.task.id);});
  }
  async fill(value) {
    const n = this.unique();
    if (n.role !== 'textbox' || n.name !== '输入任务名称或ID搜索') throw Error('Unsupported fake fill');
    await this.model.event('fill', { ...describe(n), value }, () => { this.model.search = value; });
  }
  async press(key) {
    const n = this.unique();
    if (n.name !== '输入任务名称或ID搜索' || key !== 'Enter') throw Error('Unsupported fake press');
    await this.model.event('search', { query: this.model.search }, () => {
      this.model.appliedSearch = this.model.search; this.model.page = 1;
    });
  }
  async waitFor({ state, timeoutMs }) {
    if (!['hidden', 'visible'].includes(state) || !(timeoutMs > 0)) throw Error('Unsupported fake wait');
    await this.model.event('wait', { state, timeoutMs }, () => {
      if (state === 'hidden' && this.model.loading) {
        const delay = this.model.options.loadingDelayMs ?? 5;
        this.model.now += Math.min(timeoutMs, delay);
        if (this.model.options.loadingNeverEnds || delay > timeoutMs) throw Error('fake loading timeout');
        this.model.loading = false;
      }
      const present = this.resolve().some(n => n.visible !== false);
      if ((state === 'visible') !== present) throw Error(`fake wait timeout: ${state}`);
    });
  }
  async evaluateAll(callback) {
    return this.model.event('evaluate', {}, () => callback(this.resolve().map(n => {
      if (n.role !== 'row') throw Error('Fake evaluateAll only supports rows');
      return {
        innerText: n.text,
        querySelectorAll: selector => {
          if (!['td','th,td'].includes(selector)) throw Error(`Unsupported fake selector: ${selector}`);
          return n.cells.map(cell => typeof cell==='string'?{innerText:cell,colSpan:1,rowSpan:1}:cell);
        },
        querySelector: selector => {
          if (selector !== 'input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')
            throw Error(`Unsupported fake selector: ${selector}`);
          return this.model.selected.has(n.task.id) ? { checked: true } : null;
        },
      };
    })));
  }
}

export function createFakeTab(options = {}) {
  const model = {
    options, binding: { ...fakeBinding, ...options.binding },
    tasks: (options.tasks ?? [fakeTask()]).map(t => ({ ...t })),
    headers: [...(options.headers ?? HEADERS)], pool: options.pool ?? '调控中',
    filters: [...(options.filters ?? ['全部', '全部'])], page: options.page ?? 1,
    pageSize: options.pageSize ?? 10, tabName: '调控', search: options.search ?? '',
    appliedSearch: options.search ?? '', selected: new Set(options.selected ?? []),
    menu: false, submenu: false, confirmation: null, loading: options.loading ?? false,
    now: 1000000, events: [], checkpoints: [], submitted: [], pending: null,
    refreshes: 0, disconnected: false,
    async event(type, detail, operation) {
      this.now += options.eventMs ?? 1;
      const event = { type, ...detail, at: this.now };
      this.events.push(event);
      await options.onEvent?.(event, this);
      if (this.disconnected && type !== 'checkpoint') throw Error('fake browser disconnected');
      const result = await operation?.();
      await options.afterEvent?.(event, this);
      return result;
    },
    filtered() {
      return this.tasks.filter(t => (this.pool === ALL || this.pool === '调控中' && t.status === '调控中'
        || this.pool === '手动暂停' && /已暂停/.test(t.status) && /手动暂停/.test(t.status))
        && (!this.appliedSearch || (options.overbroadSearch || t.id.includes(this.appliedSearch)
          || t.name.includes(this.appliedSearch))));
    },
    visible() { return this.filtered().slice((this.page - 1) * this.pageSize, this.page * this.pageSize); },
    currentHeaders() { return options.headersByPage?.[this.page] ?? this.headers; },
    cells(task) {
      const byHeader = {
        '任务名称': `${task.name}\nID: ${task.id}`, '调控状态': task.status,
        '调控消耗': task.cost, '调控成交订单数': task.orders,
        '调控支付ROI': task.roi, '调控预算': task.budget, '调控时长(小时)': task.hours,
      };
      return this.currentHeaders().map(h => byHeader[h] ?? '-');
    },
    nodes() {
      const node = (role, name, extra = {}) => ({ role, name, ...extra });
      const hiddenFilters=options.selectionReplacesFilters&&this.selected.size>0;
      const nodes = [node('generic','ID：'+this.binding.advertiser_id),node('generic','计划ID：'+this.binding.primary_ad_id),
        node('tab', '调控'), ...hiddenFilters?[]:[node('textbox', '输入任务名称或ID搜索'),
        ...[...this.filters, this.pool].map((value, i) => node('textbox', '请选择', { index: i, text: value }))],
        ...this.currentHeaders().map(h => node('columnheader', h)),
        ...this.visible().map(task => node('row', '', { task, cells: this.cells(task), text: this.cells(task).join('\n'),
          children: [node('checkbox', '', { task })] })),
      ];
      if(options.summaryCells)nodes.push(node('row','',{text:`共${this.filtered().length}条任务`,cells:options.summaryCells(this)}));
      if (this.filtered().length > 0) for (let p = 1; p <= Math.ceil(this.filtered().length / this.pageSize); p++) {
        if (!options.missingPages?.includes(p)) nodes.push(node('listitem', String(p), { page: p }));
      }
      if (this.menu) nodes.push(node('list', '', { text: `调控中 已暂停 ${ALL}`, children:
        ['调控中', '已暂停', ALL].filter(name=>!this.missingPausedParent||name!=='已暂停').map(name => node('option', name, { menuOption: true })) }));
      if (this.submenu) nodes.push(node('list', '', { text: '手动暂停 关联直播间未开播', children:
        ['手动暂停', '关联直播间未开播'].map(name => node('option', name, { menuOption: true })) }));
      if (this.selected.size) nodes.push(...['暂停', '开启', '停止', '删除'].map(name => node('button', name)));
      if (this.confirmation) nodes.push(node('text', this.confirmation.text), node('button', '确定'));
      if (this.loading) nodes.push(node('text', '加载中...'));
      return nodes;
    },
    snapshot() {
      const quote = JSON.stringify;
      return [
        `- generic: ID：${this.binding.advertiser_id}`,
        `- generic: 计划ID：${this.binding.primary_ad_id}`,
        `- textbox "开始日期": ${this.binding.date}`,
        `- textbox "结束日期": ${this.binding.date}`,
        ...options.selectionReplacesFilters&&this.selected.size?[]:[...[...this.filters, this.pool].map(v => `- textbox "请选择": ${quote(v)}`),
        `- textbox "输入任务名称或ID搜索"${this.search ? ': ' + quote(this.search) : ''}`],
        `- tab "调控"${this.tabName === '调控' ? ' [selected]' : ''}`,
        ...(this.selected.size ? [options.selectionReplacesFilters?`- generic: 已选${this.selected.size}个 任务`:`- generic: 已选择 ${this.selected.size} 条任务`] : []),
        ...(this.loading ? ['- generic: 加载中...'] : []),
        ...(this.confirmation ? ['- generic: '+quote(this.confirmation.text), '- button "确定"'] : []),
        ...this.currentHeaders().map(h => `- columnheader ${quote(h)}`),
        ...this.visible().flatMap(t => [`- row ${quote(this.cells(t).join('\n'))}`,
          `  - checkbox${this.selected.has(t.id) ? ' [checked]' : ''}`]),
        `- generic: 共 ${this.filtered().length} 条记录`,
        ...(this.filtered().length ? [] : ['- generic: 暂无数据']),
      ].join('\n');
    },
    async click(n) {
      if (n.role === 'tab') { this.tabName = n.name; return; }
      if (n.role === 'textbox' && n.index === 2) {
        this.menu = !this.menu; this.submenu = false; return;
      }
      if (n.menuOption) {
        if (n.name === '已暂停') { this.submenu = true; return; }
        this.pool = n.name; this.page = 1; this.menu = false; this.submenu = false; return;
      }
      if (n.role === 'listitem') { this.page = n.page; return; }
      if (n.role === 'columnheader') {
        this.refreshes++;
        if (this.pending && --this.pending.remaining <= 0) this.applyPending();
        return;
      }
      if (n.role === 'checkbox') {
        if (options.checkboxNoop) return;
        if (this.selected.has(n.task.id)) this.selected.delete(n.task.id);
        else this.selected.add(n.task.id);
        return;
      }
      if (n.role === 'button' && n.name === '确定') { await this.submit(this.confirmation.action); this.confirmation = null; return; }
      if (n.role === 'button' && ['暂停', '删除'].includes(n.name)) {
        this.confirmation = { action: n.name === '暂停' ? 'pause' : 'delete',
          text: n.name === '暂停' ? `确定暂停所选的${this.selected.size}条任务吗？`
            : `确定删除所选的${this.selected.size}条任务吗？删除后不可恢复` };
        return;
      }
      if (n.role === 'button' && ['开启', '停止'].includes(n.name)) {
        const action=n.name === '开启' ? 'resume' : 'stop';
        if(options.confirmActions?.includes(action))this.confirmation={action,text:`确定${n.name}所选的${this.selected.size}条任务吗？`};
        else await this.submit(action);
        return;
      }
      throw Error(`Unsupported fake click: ${n.role} ${n.name}`);
    },
    async submit(action) {
      await this.event('submit', { action, ids: [...this.selected] }, () => {
        this.submitted.push({ action, ids: [...this.selected] });
        this.pending = { action, ids: [...this.selected], remaining: options.readbackDelayRefreshes ?? 0 };
        if (this.pending.remaining === 0) this.applyPending();
      });
    },
    applyPending() {
      const { action, ids } = this.pending;
      if (!options.neverApply && !options.disappearAfterSubmit) {
        for (const task of this.tasks) if (ids.includes(task.id)) task.status = {
          pause: '已暂停\n手动暂停', resume: '调控中', stop: '调控结束', delete: '已删除',
        }[action];
      }
      if (options.disappearAfterSubmit) this.tasks = this.tasks.filter(t => !ids.includes(t.id));
      // Platform clears its own selection when status removes a row from a pool.
      // Off-page/manual selections remain explicit state until their author clears them.
      for (const id of ids) this.selected.delete(id);
      this.pending = null;
    },
  };
  const boundUrl = options.url ?? `https://qianchuan.jinritemai.com/overall-prom/detail?aavid=${model.binding.advertiser_id}&adId=${model.binding.primary_ad_id}`;
  const root = () => flatten(model.nodes());
  const tab = {
    id: 'isolated-fake-tab',
    url: async () => boundUrl,
    getAXState: async () => model.event('ax', {}, () => model.snapshot()),
    playwright: {
      locator: selector => {
        if(selector.split(',').some(s=>s.trim().endsWith('page-turner__item--active')))
          return new Locator(model,()=>selector.split(',').map(s=>s.trim()).includes(options.activePageSelector??'.main-vmok-plugin-page-turner__item--active')?root().filter(n=>n.role==='listitem'&&n.page===model.page):[]);
        if(selector!=='.account-info-box')throw Error('Fake CSS locator unsupported: '+selector);
        return {async evaluateAll(callback){
          const prior=Object.getOwnPropertyDescriptor(globalThis,'getComputedStyle');
          Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:element=>({display:element.display})});
          try{return callback(model.accountBoxes??[]);}finally{
            if(prior)Object.defineProperty(globalThis,'getComputedStyle',prior);else delete globalThis.getComputedStyle;
          }
        }};
      },
      domSnapshot: async () => model.event('snapshot', {}, () => model.snapshot()),
      getByRole: (role, args = {}) => new Locator(model, () => root().filter(n => n.role === role
        && (args.name === undefined || matches(n.name ?? '', args.name, args.exact)))),
      getByText: (text, args = {}) => new Locator(model, () => root().filter(n => matches(textOf(n), text, args.exact))),
    },
  };
  const checkpoint = async value => model.event('checkpoint', { id: value.id, status: value.status }, () => {
    model.checkpoints.push(structuredClone({ evidence_origin: 'isolated_fixture', ...value }));
  });
  return { tab, model, binding: { ...model.binding }, checkpoint };
}
